import { QQBot } from "@tencent-connect/qqbot-nodejs";
import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";
import { chunkText } from "../types.js";

/**
 * QQ 渠道运行时：官方 qqbot-nodejs SDK，WebSocket 长连接（含心跳/RESUME）。
 * 凭据：appId + appSecret（扫码或 QQ 开放平台手动创建获得）。
 * 聊天标识：c2c:<openid> / group:<group_openid>。
 */
export class QqRuntime implements ChannelRuntime {
	readonly channel = "qq" as const;
	readonly botId: string;
	private runningFlag = false;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private client: QQBot | null = null;
	private abort: AbortController | null = null;
	private ok = false;

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	/** 验证凭据：SDK 启动即做 token 获取，失败会抛错，此处仅检查字段 */
	async verify(): Promise<string> {
		const appId = this.bot.credentials.appId;
		const appSecret = this.bot.credentials.appSecret;
		if (!appId || !appSecret) {
			throw new Error("QQ 凭据缺失（appId / appSecret）");
		}
		return this.bot.name;
	}

	async start(): Promise<void> {
		if (this.runningFlag) return;
		const client = new QQBot({
			appId: this.bot.credentials.appId,
			appSecret: this.bot.credentials.appSecret,
			accountId: this.bot.botId,
		});
		client.on("message", async (_ctx, msg) => {
			try {
				if (msg.kind !== "c2c" && msg.kind !== "group") return; // 频道消息暂不支持
				const content = msg.content?.trim();
				if (!content) return;
				const chatId = msg.kind === "group" ? `group:${msg.groupOpenid ?? ""}` : `c2c:${msg.senderId}`;
				const normalized = content
					// 去掉 @机器人 前缀
					.replace(/^@\S+\s*/, "")
					.trim();
				if (!normalized) return;
				const message: InboundMessage = {
					route: { channel: "qq", botId: this.bot.botId, chatId },
					text: normalized,
					senderId: msg.senderId,
					senderName: msg.senderName,
					isGroup: msg.kind === "group",
				};
				this.onMessage(message);
			} catch (err) {
				this.log.error("[pi-im:qq] 处理消息失败:", err);
			}
		});
		client.on("error", (err: unknown) => {
			this.log.warn("[pi-im:qq] 连接错误:", err);
		});
		this.client = client;
		this.abort = new AbortController();
		// start() 在连接关闭时 resolve，放后台
		void client.start(this.abort.signal).catch((err) => {
			if (!this.abort?.signal.aborted) {
				this.ok = false;
				this.log.error("[pi-im:qq] 连接退出:", err);
			}
		});
		this.runningFlag = true;
		this.ok = true;
		this.log.info(`[pi-im:qq] 机器人 ${this.bot.botId} 已上线（WS 长连接）`);
	}

	async send(route: Route, text: string): Promise<void> {
		if (!this.client) throw new Error("QQ 机器人未连接");
		const isGroup = route.chatId.startsWith("group:");
		const targetId = isGroup ? route.chatId.slice("group:".length) : route.chatId.slice("c2c:".length);
		const target = { scope: isGroup ? ("group" as const) : ("c2c" as const), targetId };
		for (const part of chunkText(text)) {
			await this.client.sendText(target, part);
		}
	}

	healthy(): boolean {
		return this.ok && this.runningFlag;
	}

	async stop(): Promise<void> {
		this.runningFlag = false;
		this.ok = false;
		this.abort?.abort();
		this.client?.stop();
		this.client = null;
		this.abort = null;
	}
}
