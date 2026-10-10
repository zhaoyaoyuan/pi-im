import * as Lark from "@larksuiteoapi/node-sdk";
import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, Route, RuntimeLogger } from "../types.js";
import { chunkText } from "../types.js";
import { buildFeishuCardMessages } from "./feishu-md.js";

interface FeishuEventMessage {
	chat_id: string;
	chat_type: "p2p" | "group";
	message_id: string;
	message_type: string;
	text?: string;
	/** 群聊 @ 的 open_id 列表 */
	mentions?: string[];
}

/**
 * 飞书渠道运行时：官方 SDK WebSocket 长连接接收事件，OpenAPI 发消息。
 * 凭据：appId + appSecret（扫码注册或手动绑定获得）。
 */
export class FeishuRuntime implements ChannelRuntime {
	readonly channel = "feishu" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private ws: Lark.WSClient | null = null;
	private running = false;
	private ok = false;
	private lastChatId: string | null = null;

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	/** 验证凭据：获取 tenant_access_token 成功即视为凭据有效 */
	async verify(): Promise<string> {
		const res = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				app_id: this.bot.credentials.appId,
				app_secret: this.bot.credentials.appSecret,
			}),
			signal: AbortSignal.timeout(10_000),
		});
		const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
		if (!res.ok || data.code !== 0 || !data.tenant_access_token) {
			throw new Error(`飞书凭据校验失败: code=${data.code} ${data.msg ?? ""}`);
		}
		return this.bot.name;
	}

	private makeClient(): Lark.Client {
		return new Lark.Client({
			appId: this.bot.credentials.appId,
			appSecret: this.bot.credentials.appSecret,
		});
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.running = true;

		const dispatcher = new Lark.EventDispatcher({});
		dispatcher.register({
			"im.message.receive_v1": async (data: unknown) => {
				try {
					const msg = this.normalize(data);
					if (msg) {
						this.lastChatId = msg.route.chatId;
						this.onMessage(msg);
					}
				} catch (err) {
					this.log.error("[pi-im:feishu] 处理消息失败:", err);
				}
			},
		});

		this.ws = new Lark.WSClient({
			appId: this.bot.credentials.appId,
			appSecret: this.bot.credentials.appSecret,
			domain: Lark.Domain.Feishu,
			loggerLevel: Lark.LoggerLevel.warn,
		});
		await this.ws.start({ eventDispatcher: dispatcher });
		this.ok = true;
		this.log.info(`[pi-im:feishu] 机器人 ${this.bot.botId} 已上线（WS 长连接）`);
	}

	/** 把 SDK 事件归一化为 InboundMessage */
	private normalize(data: unknown): InboundMessage | null {
		const d = data as {
			message?: {
				chat_id: string;
				chat_type: "p2p" | "group";
				message_id: string;
				message_type: string;
				content?: string;
				mentions?: { key: string; id?: { open_id?: string }; name?: string }[];
			};
			sender?: { sender_id?: { open_id?: string } };
		};
		const m = d?.message;
		if (!m || m.message_type !== "text" || !m.content) return null;

		let text = "";
		try {
			const parsed = JSON.parse(m.content) as { text?: string };
			text = parsed.text ?? "";
		} catch {
			return null;
		}

		// 群聊：去掉 @机器人 占位符（@_user_1）
		text = text.replace(/@_user_\d+/g, "").trim();
		if (!text) return null;

		// 群聊只响应 @机器人 的消息
		if (m.chat_type === "group" && !(m.mentions?.length)) return null;

		return {
			route: { channel: "feishu", botId: this.bot.botId, chatId: m.chat_id },
			text,
			senderId: d.sender?.sender_id?.open_id ?? "",
			isGroup: m.chat_type === "group",
		};
	}

	async send(route: Route, text: string): Promise<void> {
		const client = this.makeClient();
		// 优先：markdown → 交互卡片（原生渲染表格/加粗/代码块）；失败降级为纯文本分段
		try {
			const cards = buildFeishuCardMessages(text);
			if (cards.length) {
				for (const card of cards) {
					await client.im.message.create({
						params: { receive_id_type: "chat_id" },
						data: { receive_id: route.chatId, msg_type: "interactive", content: card },
					});
				}
				return;
			}
		} catch (err) {
			this.log.warn("[pi-im:feishu] 卡片发送失败，降级为纯文本:", (err as Error).message);
		}
		for (const part of chunkText(text)) {
			await client.im.message.create({
				params: { receive_id_type: "chat_id" },
				data: {
					receive_id: route.chatId,
					msg_type: "text",
					content: JSON.stringify({ text: part }),
				},
			});
		}
	}

	/** 连接测试：发送到最近一次收到消息的聊天 */
	async sendTest(text: string): Promise<boolean> {
		if (!this.lastChatId) return false;
		await this.send({ channel: "feishu", botId: this.bot.botId, chatId: this.lastChatId }, text);
		return true;
	}

	healthy(): boolean {
		return this.ok && this.running;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.ok = false;
		try {
			await this.ws?.close();
		} catch {
			// 忽略关闭错误
		}
		this.ws = null;
	}
}
