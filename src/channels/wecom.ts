import { WSClient } from "@wecom/aibot-node-sdk";
import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";

interface WecomFrame {
	headers?: Record<string, unknown>;
	body?: {
		msgtype?: string;
		text?: { content?: string };
		chattype?: "single" | "group";
		chatid?: string;
		from?: { userid?: string };
	};
}

/**
 * 企业微信（智能机器人）渠道运行时：官方 aibot-node-sdk WebSocket 长连接。
 * 凭据：botId（扫码获得）+ secret。
 */
export class WecomRuntime implements ChannelRuntime {
	readonly channel = "wecom" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private client: WSClient | null = null;
	private running = false;
	private ok = false;
	/** 记住最近聊天的 frame，优先 reply，主动投递用 sendMessage */
	private lastFrameByChat = new Map<string, WecomFrame>();

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	/** 验证凭据：建连即校验（WSClient 认证失败会抛 WSAuthFailureError），此处仅检查字段 */
	async verify(): Promise<string> {
		if (!this.bot.credentials.botId || !this.bot.credentials.secret) {
			throw new Error("企业微信凭据缺失（botId / secret）");
		}
		return this.bot.name;
	}

	async start(): Promise<void> {
		if (this.running) return;
		const client = new WSClient({
			botId: this.bot.credentials.botId,
			secret: this.bot.credentials.secret,
			maxReconnectAttempts: 10,
		});
		client.on("message", (frame: WecomFrame) => {
			try {
				const body = frame?.body;
				if (!body || body.msgtype !== "text" || !body.text?.content?.trim()) return;
				const senderId = body.from?.userid ?? "";
				const chatId = body.chattype === "group" ? body.chatid ?? "" : senderId;
				if (!chatId) return;
				this.lastFrameByChat.set(chatId, frame);
				const msg: InboundMessage = {
					route: { channel: "wecom", botId: this.bot.botId, chatId },
					text: body.text.content.trim(),
					senderId,
					isGroup: body.chattype === "group",
				};
				this.onMessage(msg);
			} catch (err) {
				this.log.error("[pi-im:wecom] 处理消息失败:", err);
			}
		});
		client.on("error", (err: unknown) => {
			this.log.warn("[pi-im:wecom] 连接错误:", err);
		});
		this.client = client;
		await client.connect();
		this.running = true;
		this.ok = true;
		this.log.info(`[pi-im:wecom] 机器人 ${this.bot.botId} 已上线（WS 长连接）`);
	}

	async send(route: Route, text: string): Promise<void> {
		if (!this.client) throw new Error("企业微信机器人未连接");
		await this.client.sendMessage(route.chatId, { msgtype: "markdown", markdown: { content: text } });
	}

	healthy(): boolean {
		return this.ok && this.running && this.client?.isConnected === true;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.ok = false;
		try {
			await this.client?.disconnect();
		} catch {
			// 忽略关闭错误
		}
		this.client = null;
	}
}
