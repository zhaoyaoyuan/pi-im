import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason } from "@whiskeysockets/baileys";
import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";
import { chunkText } from "../types.js";
import { imHome } from "../store.js";

interface BaileysMessageValue {
	key?: { remoteJid?: string; fromMe?: boolean; id?: string };
	pushName?: string;
	message?: { conversation?: string; extendedTextMessage?: { text?: string } };
}

/**
 * WhatsApp 渠道运行时：Baileys 关联设备（扫码 link device）。
 * 凭据：Baileys 会话密钥，保存在 ~/.pi/im/whatsapp-session/。
 * 聊天标识：JID（个人 xxx@s.whatsapp.net）。
 * 默认仅响应"自聊"（fromMe 且 jid 为自己的单聊），避免误回联系人消息。
 */
export class WhatsappRuntime implements ChannelRuntime {
	readonly channel = "whatsapp" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private socket: ReturnType<typeof makeWASocket> | null = null;
	private running = false;
	private ok = false;
	private stopped = false;
	/** 收到二维码时回调（绑定时展示） */
	onQr?: (qr: string) => void;

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	async verify(): Promise<string> {
		// Baileys 无独立验证接口，凭据状态在 start 时体现
		return this.bot.name;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.stopped = false;
		const authDir = join(imHome(), "whatsapp-session");
		await mkdir(authDir, { recursive: true });
		const { state, saveCreds } = await useMultiFileAuthState(authDir);
		const { version } = await fetchLatestBaileysVersion();

		const socket = makeWASocket({
			version,
			auth: state,
			printQRInTerminal: false,
			syncFullHistory: false,
		});
		this.socket = socket;

		socket.ev.on("creds.update", saveCreds);
		socket.ev.on("connection.update", ((update: { connection?: string; qr?: string; lastDisconnect?: { error?: { output?: number } } }) => {
			if (update.qr && this.onQr) this.onQr(update.qr);
			if (update.connection === "open") {
				this.ok = true;
				this.log.info(`[pi-im:whatsapp] 已关联上线（WhatsApp Web 会话）`);
			}
			if (update.connection === "close") {
				this.ok = false;
				const code = update.lastDisconnect?.error?.output;
				if (code === DisconnectReason.loggedOut) {
					this.log.error("[pi-im:whatsapp] 会话已登出，请重新绑定");
					this.running = false;
					return;
				}
				if (!this.stopped) {
					setTimeout(() => {
						if (!this.stopped) void this.start().catch((err) => this.log.error("[pi-im:whatsapp] 重连失败:", err));
					}, 3_000);
				}
			}
		}) as never);
		socket.ev.on("messages.upsert", ((upsert: { type?: string; messages?: BaileysMessageValue[] }) => {
			try {
				if (upsert.type !== "notify" && upsert.type !== "append") return;
				for (const value of upsert.messages ?? []) {
					const jid = value.key?.remoteJid;
					const text = value.message?.conversation ?? value.message?.extendedTextMessage?.text;
					if (!jid || !text?.trim() || !value.key) continue;
					if (jid.endsWith("@g.us") || jid.endsWith("@broadcast")) continue; // MVP：仅单聊
					// 默认仅响应自聊（自己给自己发消息当输入入口）
					if (!value.key.fromMe) continue;
					const chatId = jid;
					const msg: InboundMessage = {
						route: { channel: "whatsapp", botId: this.bot.botId, chatId },
						text: text.trim(),
						senderId: "me",
						senderName: value.pushName,
						isGroup: false,
					};
					this.onMessage(msg);
				}
			} catch (err) {
				this.log.error("[pi-im:whatsapp] 处理消息失败:", err);
			}
		}) as never);

		this.running = true;
	}

	async send(route: Route, text: string): Promise<void> {
		if (!this.socket) throw new Error("WhatsApp 未连接");
		for (const part of chunkText(text)) {
			await this.socket.sendMessage(route.chatId, { text: part });
		}
	}

	healthy(): boolean {
		return this.ok && this.running;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.running = false;
		this.ok = false;
		try {
			this.socket?.end(undefined);
		} catch {
			// 忽略
		}
		this.socket = null;
	}
}
