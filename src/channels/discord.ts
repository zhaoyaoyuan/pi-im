import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";
import { chunkText } from "../types.js";

const API = "https://discord.com/api/v10/";
/** GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT */
const INTENTS = 1 << 0 | 1 << 9 | 1 << 10 | 1 << 15;

interface GatewayPacket {
	op: number;
	t?: string;
	s?: number;
	d?: unknown;
}

/**
 * Discord 渠道运行时：原生 Gateway v10 实现（无需 discord.js）。
 * - REST 验证 token + 获取 gateway 地址
 * - WS：op10 HELLO → 心跳 → op2 IDENTIFY → op0 READY/MESSAGE_CREATE
 * - 私信直接回复；服务器频道消息需 @ 或私信（MVP：仅处理私信与 @ 消息）
 * 凭据：Bot Token。聊天标识：channel ID。
 */
export class DiscordRuntime implements ChannelRuntime {
	readonly channel = "discord" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private socket: WebSocket | null = null;
	private running = false;
	private ok = false;
	private stopped = false;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private heartbeatAcked = true;
	private sequence: number | null = null;
	private botUserId = "";
	private pendingSeq: number | null = null;
	private sessionId: string | null = null;
	private gatewayUrl = "wss://gateway.discord.gg/?v=10&encoding=json";

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	private async api(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
		const res = await fetch(`${API}${path}`, {
			...init,
			headers: {
				authorization: `Bot ${this.bot.credentials.token}`,
				"content-type": "application/json",
				...(init?.headers ?? {}),
			},
			signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(init?.signal ? [init.signal] : [])]),
		});
		if (!res.ok) throw new Error(`Discord API ${path} HTTP ${res.status}`);
		return (await res.json()) as Record<string, unknown>;
	}

	/** 验证凭据并缓存 gateway 地址与自身用户 ID */
	async verify(): Promise<string> {
		const me = await this.api("users/@me");
		const username = String(me.username ?? "");
		if (!me.id || me.bot !== true) throw new Error("Discord token 无效");
		this.botUserId = String(me.id);
		const gateway = await this.api("gateway/bot");
		if (typeof gateway.url === "string") this.gatewayUrl = `${gateway.url}?v=10&encoding=json`;
		return username;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.stopped = false;
		this.running = true;
		await this.openSocket();
	}

	private sendGateway(packet: GatewayPacket): void {
		this.socket?.send(JSON.stringify(packet));
	}

	private startHeartbeat(intervalMs: number): void {
		this.stopHeartbeat();
		this.heartbeatTimer = setInterval(() => {
			if (!this.heartbeatAcked) {
				this.socket?.close(4000, "heartbeat timeout");
				return;
			}
			this.heartbeatAcked = false;
			this.sendGateway({ op: 1, d: this.sequence ?? undefined });
		}, intervalMs);
	}

	private stopHeartbeat(): void {
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		this.heartbeatTimer = null;
	}

	private async openSocket(): Promise<void> {
		const socket = new WebSocket(this.gatewayUrl);
		this.socket = socket;
		socket.onmessage = (event: MessageEvent) => this.handlePacket(String(event.data));
		socket.onclose = () => {
			this.stopHeartbeat();
			this.ok = false;
			this.socket = null;
			if (!this.stopped && this.running) {
				setTimeout(() => {
					if (!this.stopped && this.running) void this.openSocket().catch((err) => this.log.error("[pi-im:discord] 重连失败:", err));
				}, 3_000);
			}
		};
		socket.onerror = (err) => this.log.warn("[pi-im:discord] socket 错误:", err);
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("Discord Gateway 就绪超时")), 20_000);
			const check = setInterval(() => {
				if (this.sessionId) {
					clearTimeout(timer);
					clearInterval(check);
					resolve();
				}
			}, 100);
			socket.onclose = () => {
				clearTimeout(timer);
				clearInterval(check);
				reject(new Error("Discord Gateway 连接被关闭"));
			};
		});
	}

	private handlePacket(raw: string): void {
		let packet: GatewayPacket;
		try {
			packet = JSON.parse(raw);
		} catch {
			return;
		}
		if (Number.isSafeInteger(packet.s)) this.sequence = packet.s as number;

		switch (packet.op) {
			case 10: { // HELLO
				const interval = Number((packet.d as { heartbeat_interval?: number } | undefined)?.heartbeat_interval ?? 41250);
				this.startHeartbeat(interval);
				this.sendGateway({
					op: 2,
					d: {
						token: this.bot.credentials.token,
						intents: INTENTS,
						properties: { os: process.platform, browser: "pi-im", device: "pi-im" },
					},
				});
				return;
			}
			case 11: // HEARTBEAT_ACK
				this.heartbeatAcked = true;
				return;
			case 1: // server heartbeat
				this.sendGateway({ op: 1, d: this.sequence ?? undefined });
				return;
			case 7: // reconnect requested
				this.socket?.close(4000, "Reconnect requested");
				return;
			case 9: // invalid session
				this.sessionId = null;
				this.sequence = null;
				this.socket?.close(4000, "Invalid session");
				return;
			case 0:
				break; // dispatch，往下处理
			default:
				return;
		}

		if (packet.t === "READY") {
			this.sessionId = String((packet.d as { session_id?: string }).session_id ?? "");
			this.ok = true;
			this.log.info(`[pi-im:discord] 机器人 ${this.bot.botId} 已上线（Gateway）`);
			return;
		}
		if (packet.t !== "MESSAGE_CREATE") return;
		const d = packet.d as {
			id?: string;
			channel_id?: string;
			author?: { id?: string; username?: string; bot?: boolean };
			content?: string;
			guild_id?: string;
			mentions?: { id?: string }[];
		};
		if (!d?.id || !d.channel_id || !d.author?.id) return;
		if (d.author.bot) return; // 忽略机器人
		const content = d.content?.trim();
		if (!content) return;
		const isGroup = Boolean(d.guild_id);
		// 群聊只处理 @机器人 的消息
		const mentioned = (d.mentions ?? []).some((m) => m.id === this.botUserId);
		if (isGroup && !mentioned) return;
		const text = content.replace(/^<@[^>]+>\s*/, "").trim();
		if (!text) return;
		const msg: InboundMessage = {
			route: { channel: "discord", botId: this.bot.botId, chatId: d.channel_id },
			text,
			senderId: d.author.id,
			senderName: d.author.username,
			isGroup,
		};
		this.onMessage(msg);
	}

	async send(route: Route, text: string): Promise<void> {
		for (const part of chunkText(text)) {
			await this.api(`channels/${route.chatId}/messages`, {
				method: "POST",
				body: JSON.stringify({ content: part }),
			});
		}
	}

	healthy(): boolean {
		return this.ok && this.running && this.socket?.readyState === WebSocket.OPEN;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		this.running = false;
		this.ok = false;
		this.stopHeartbeat();
		try {
			this.socket?.close(1000, "pi-im stopped");
		} catch {
			// 忽略
		}
		this.socket = null;
	}
}
