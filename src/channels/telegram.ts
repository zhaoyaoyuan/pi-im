import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, Route, RuntimeLogger } from "../types.js";
import { chunkText } from "../types.js";

const API = "https://api.telegram.org";

interface TgResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	/** 429 时返回 */
	parameters?: { retry_after?: number };
}

interface TgUpdate {
	update_id: number;
	message?: {
		message_id: number;
		date: number;
		text?: string;
		chat: { id: number; type: string; title?: string };
		from?: { id: number; first_name?: string; username?: string };
	};
}

/**
 * Telegram 渠道运行时：Bot API 长轮询收消息，sendMessage 发回复。
 * 凭据仅需 BotFather 颁发的 Bot Token。
 */
export class TelegramRuntime implements ChannelRuntime {
	readonly channel = "telegram" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private abort: AbortController | null = null;
	private offset = 0;
	private running = false;
	private ok = false;
	/** 可发送目标（私聊/群聊记忆，用于连接测试） */
	private lastChatId: string | null = null;

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	private async call<T>(method: string, body?: unknown, signal?: AbortSignal, longPollMs?: number): Promise<T> {
		const res = await fetch(`${API}/bot${this.bot.credentials.token}/${method}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body ?? {}),
			signal,
		} as RequestInit);
		const data = (await res.json()) as TgResponse<T>;
		if (!data.ok) {
			const err = new Error(`telegram ${method} 失败: HTTP ${data.error_code ?? res.status} ${data.description ?? ""}`);
			(err as Error & { retryAfter?: number }).retryAfter = data.parameters?.retry_after;
			throw err;
		}
		return data.result as T;
	}

	/** 绑定时验证 token，返回机器人用户名 */
	async verify(): Promise<string> {
		const me = await this.call<{ username?: string }>("getMe", undefined, AbortSignal.timeout(10_000));
		return me.username ?? this.bot.botId;
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abort = new AbortController();
		void this.pollLoop();
	}

	private async pollLoop(): Promise<void> {
		const signal = this.abort!.signal;
		while (!signal.aborted && this.running) {
			try {
				const updates = await this.call<TgUpdate[]>(
					"getUpdates",
					{ offset: this.offset, timeout: 25, allowed_updates: ["message"] },
					signal,
					35_000,
				);
				this.ok = true;
				for (const u of updates ?? []) {
					this.offset = Math.max(this.offset, u.update_id + 1);
					const m = u.message;
					if (!m?.text) continue;
					this.lastChatId = String(m.chat.id);
					let text = m.text.trim();
					// 群聊中 /cmd@botname 形式去掉 @botname
					text = text.replace(new RegExp(`^(/\\w+)@${this.bot.botId}\\b`), "$1");
					const msg: InboundMessage = {
						route: { channel: "telegram", botId: this.bot.botId, chatId: String(m.chat.id) },
						text,
						senderId: String(m.from?.id ?? ""),
						senderName: m.from?.first_name ?? m.from?.username,
						isGroup: m.chat.type === "group" || m.chat.type === "supergroup",
					};
					this.onMessage(msg);
				}
			} catch (err) {
				if (signal.aborted || !this.running) return;
				this.ok = false;
				const retryAfter = (err as Error & { retryAfter?: number }).retryAfter;
				const delay = retryAfter ? retryAfter * 1000 : 3000;
				this.log.warn("[pi-im:telegram] 轮询异常，", delay / 1000, "s 后重试:", (err as Error).message);
				await new Promise((r) => setTimeout(r, delay));
			}
		}
	}

	async send(route: Route, text: string): Promise<void> {
		for (const part of chunkText(text)) {
			await this.call("sendMessage", { chat_id: route.chatId, text: part }, AbortSignal.timeout(15_000));
		}
	}

	/** 连接测试：发送到最近私聊 */
	async sendTest(text: string): Promise<boolean> {
		if (!this.lastChatId) return false;
		await this.send({ channel: "telegram", botId: this.bot.botId, chatId: this.lastChatId }, text);
		return true;
	}

	healthy(): boolean {
		return this.ok && this.running;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.ok = false;
		this.abort?.abort();
		this.abort = null;
	}
}
