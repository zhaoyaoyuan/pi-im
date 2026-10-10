import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";
import { chunkText } from "../types.js";
import {
	DEFAULT_LONG_POLL_TIMEOUT_MS,
	WeixinApiError,
	weixinGetUpdates,
	weixinNotifyStart,
	weixinNotifyStop,
	weixinSendText,
	type WeixinUpdateMessage,
} from "./weixin-api.js";

/**
 * 微信个人号渠道运行时：iLink 长轮询。
 * - start() 后 notifyStart → getupdates 长轮询循环（增量 buf 持久到凭据文件）
 * - 每个联系人记住最新 context_token（会话能力，发送时带上）
 * - 凭据：token + accountId + ownerUserId + baseUrl（扫码确认后获得）
 * - 聊天标识：联系人 ilink user id（from_user_id）
 */
export class WeixinRuntime implements ChannelRuntime {
	readonly channel = "weixin" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private abort: AbortController | null = null;
	private running = false;
	private ok = false;
	private getUpdatesBuf = "";
	/** 联系人 → 最新 context_token */
	private contextTokens = new Map<string, string>();
	/** 聊天标识 → 收件人 user id（MVP 单聊 1:1） */
	private chatUsers = new Map<string, string>();

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	/** 验证凭据字段完整性 */
	async verify(): Promise<string> {
		const c = this.bot.credentials;
		if (!c.token || !c.accountId || !c.baseUrl) {
			throw new Error("微信凭据缺失（token/accountId/baseUrl），请移除后重新扫码绑定。");
		}
		return this.bot.name || "微信";
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;
		this.abort = new AbortController();
		// 恢复历史增量游标与 context tokens
		this.getUpdatesBuf = this.bot.credentials.getUpdatesBuf ?? "";
		const savedTokens = this.bot.credentials.contextTokens ? (JSON.parse(this.bot.credentials.contextTokens) as Record<string, string>) : {};
		for (const [k, v] of Object.entries(savedTokens)) this.contextTokens.set(k, v);

		await weixinNotifyStart({ baseUrl: this.bot.credentials.baseUrl, token: this.bot.credentials.token, signal: this.abort.signal });
		this.ok = true;
		this.log.info(`[pi-im:weixin] 账号 ${this.bot.name || this.bot.botId} 已上线（iLink 长轮询）`);
		void this.pollLoop();
	}

	private async pollLoop(): Promise<void> {
		const signal = this.abort!.signal;
		let consecutiveFailures = 0;
		while (!signal.aborted && this.running) {
			try {
				const { msgs, getUpdatesBuf } = await weixinGetUpdates({
					baseUrl: this.bot.credentials.baseUrl,
					token: this.bot.credentials.token,
					getUpdatesBuf: this.getUpdatesBuf,
					signal,
				});
				consecutiveFailures = 0;
				this.ok = true;
				if (getUpdatesBuf && getUpdatesBuf !== this.getUpdatesBuf) {
					this.getUpdatesBuf = getUpdatesBuf;
					this.bot.credentials.getUpdatesBuf = getUpdatesBuf;
				}
				for (const msg of msgs) this.accept(msg);
			} catch (err) {
				if (signal.aborted || !this.running) return;
				consecutiveFailures += 1;
				this.ok = false;
				if (err instanceof WeixinApiError && err.code === "stale-token") {
					this.log.error("[pi-im:weixin] 登录凭据已失效，请移除账号后重新扫码绑定。");
					return;
				}
				this.log.warn("[pi-im:weixin] 轮询异常（连续第", consecutiveFailures, "次）:", (err as Error).message);
				if (consecutiveFailures >= 5) {
					this.log.error("[pi-im:weixin] 连续失败过多，停止轮询。请用 /im reconnect weixin 重试。");
					return;
				}
				await new Promise((r) => setTimeout(r, Math.min(2000 * 2 ** (consecutiveFailures - 1), 10_000)));
			}
		}
	}

	/** 归一化一条 iLink 消息 */
	private accept(msg: WeixinUpdateMessage): void {
		try {
			const fromUser = msg.from_user_id?.trim();
			if (!fromUser) return;
			// 提取文本（type=1 文本；type=3 语音转写文本）
			let text: string | null = null;
			for (const item of msg.item_list ?? []) {
				if (item?.type === 1 && typeof item.text_item?.text === "string" && item.text_item.text.trim()) {
					text = item.text_item.text.trim();
					break;
				}
				if (item?.type === 3 && typeof item.voice_item?.text === "string" && item.voice_item.text.trim()) {
					text = `[语音] ${item.voice_item.text.trim()}`;
					break;
				}
			}
			if (!text) return; // 图片/文件等暂不支持
			// 记住会话能力
			if (msg.context_token) this.contextTokens.set(fromUser, msg.context_token);
			this.chatUsers.set(fromUser, fromUser);
			this.onMessage({
				route: { channel: "weixin", botId: this.bot.botId, chatId: fromUser },
				text,
				senderId: fromUser,
				isGroup: false,
			});
		} catch (err) {
			this.log.error("[pi-im:weixin] 处理消息失败:", err);
		}
	}

	private currentContextTokensJson(): string {
		return JSON.stringify(Object.fromEntries(this.contextTokens));
	}

	/** 供绑定流程在保存凭据时带上最新增量游标 */
	get credentialsSnapshot(): { getUpdatesBuf?: string; contextTokens?: string } {
		return {
			...(this.getUpdatesBuf ? { getUpdatesBuf: this.getUpdatesBuf } : {}),
			...(this.contextTokens.size ? { contextTokens: this.currentContextTokensJson() } : {}),
		};
	}

	async send(route: Route, text: string): Promise<void> {
		const toUser = route.chatId;
		const contextToken = this.contextTokens.get(toUser);
		// 微信单条 1800 字上限，超长分段发送
		for (const part of chunkText(text, 1_800)) {
			await weixinSendText({
				baseUrl: this.bot.credentials.baseUrl,
				token: this.bot.credentials.token,
				toUserId: toUser,
				text: part,
				contextToken,
			});
		}
	}

	healthy(): boolean {
		return this.ok && this.running;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.ok = false;
		try {
			await weixinNotifyStop({ baseUrl: this.bot.credentials.baseUrl, token: this.bot.credentials.token });
		} catch {
			// 停止通知失败不阻塞退出
		}
		this.abort?.abort();
		this.abort = null;
	}
}

export { DEFAULT_LONG_POLL_TIMEOUT_MS };
