import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";
import { chunkText } from "../types.js";

const SLACK_API = "https://slack.com/api";

/**
 * Slack 渠道运行时：原生 Socket Mode 实现（无需额外依赖）。
 * - apps.connections.open（App Token xapp-）拿 WSS 地址
 * - 全局 WebSocket 收 events_api 包，回执 envelope_id
 * - chat.postMessage（Bot Token xoxb-）发送
 * 凭据：botToken + appToken。聊天标识：channel ID。
 */
export class SlackRuntime implements ChannelRuntime {
	readonly channel = "slack" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private socket: WebSocket | null = null;
	private running = false;
	private ok = false;
	private botUserId = "";
	private reconnectDelayMs = 1_000;
	private stopped = false;

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	private async api(method: string, body: Record<string, unknown> = {}, tokenKind: "bot" | "app" = "bot"): Promise<Record<string, unknown>> {
		const token = tokenKind === "bot" ? this.bot.credentials.botToken : this.bot.credentials.appToken;
		const res = await fetch(`${SLACK_API}/${method}`, {
			method: "POST",
			headers: {
				"content-type": "application/json; charset=utf-8",
				authorization: `Bearer ${token}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		return (await res.json()) as Record<string, unknown>;
	}

	/** 验证凭据：auth.test + Socket Mode 连接可用性 */
	async verify(): Promise<string> {
		const auth = await this.api("auth.test");
		if (auth.ok !== true) throw new Error(`Slack Bot Token 校验失败: ${String(auth.error ?? "")}`);
		this.botUserId = String(auth.user_id ?? "");
		const conn = await this.api("apps.connections.open", {}, "app");
		if (conn.ok !== true || typeof conn.url !== "string") {
			throw new Error("Slack App Token 无法建立 Socket Mode，请确认已启用 Socket Mode 与 connections:write");
		}
		return String(auth.user ?? "slack-bot");
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.stopped = false;
		this.running = true;
		await this.openSocket();
	}

	private async openSocket(): Promise<void> {
		const conn = await this.api("apps.connections.open", {}, "app");
		if (conn.ok !== true || typeof conn.url !== "string") {
			throw new Error(`Slack Socket Mode 连接失败: ${String(conn.error ?? "")}`);
		}
		const socket = new WebSocket(conn.url);
		this.socket = socket;
		socket.onmessage = (event: MessageEvent) => {
			void this.handlePacket(String(event.data), socket);
		};
		socket.onclose = () => {
			this.ok = false;
			this.socket = null;
			if (!this.stopped && this.running) {
				// 指数退避重连
				setTimeout(() => {
					if (!this.stopped && this.running) void this.openSocket().catch((err) => this.log.error("[pi-im:slack] 重连失败:", err));
				}, this.reconnectDelayMs);
				this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
			}
		};
		socket.onerror = (err) => this.log.warn("[pi-im:slack] socket 错误:", err);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Slack Socket Mode 连接超时")), 15_000);
			socket.onopen = () => {
				clearTimeout(timer);
				this.ok = true;
				this.reconnectDelayMs = 1_000;
				resolve();
			};
		});
		this.log.info(`[pi-im:slack] 机器人 ${this.bot.botId} 已上线（Socket Mode）`);
	}

	private async handlePacket(raw: string, socket: WebSocket): Promise<void> {
		let packet: {
			type?: string;
			envelope_id?: string;
			payload?: {
				type?: string;
				event?: {
					type?: string;
					channel?: string;
					user?: string;
					text?: string;
					ts?: string;
					channel_type?: string;
					bot_id?: string;
				};
				api_app_id?: string;
			};
		};
		try {
			packet = JSON.parse(raw);
		} catch {
			return;
		}
		// Socket Mode 要求回执 envelope
		if (packet.envelope_id && socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify({ envelope_id: packet.envelope_id }));
		}
		if (packet.type === "close") {
			socket.close(4000, "Slack requested reconnect");
			return;
		}
		const evt = packet.payload?.event;
		if (packet.payload?.type !== "event_callback" || !evt) return;
		if (evt.type !== "message" && evt.type !== "app_mention") return;
		if (!evt.text || !evt.channel || !evt.user) return;
		if (evt.bot_id) return; // 忽略机器人自身/其他 bot
		// 忽略消息编辑/删除等子类型
		if (packet.payload && typeof packet.payload === "object" && "event" in packet.payload) {
			const sub = (evt as { subtype?: string }).subtype;
			if (sub) return;
		}
		let text = evt.text.trim();
		// 去掉 @机器人 前缀
		text = text.replace(/^<@\w+>\s*/, "").trim();
		if (!text) return;
		const msg: InboundMessage = {
			route: { channel: "slack", botId: this.bot.botId, chatId: evt.channel },
			text,
			senderId: evt.user,
			isGroup: evt.channel_type !== "im",
		};
		this.onMessage(msg);
	}

	async send(route: Route, text: string): Promise<void> {
		for (const part of chunkText(text)) {
			const res = await this.api("chat.postMessage", { channel: route.chatId, text: part });
			if (res.ok !== true) throw new Error(`Slack 发送失败: ${String(res.error ?? "")}`);
		}
	}

	healthy(): boolean {
		return this.ok && this.running && this.socket?.readyState === WebSocket.OPEN;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.running = false;
		this.ok = false;
		try {
			this.socket?.close(1000, "pi-im stopped");
		} catch {
			// 忽略
		}
		this.socket = null;
	}
}
