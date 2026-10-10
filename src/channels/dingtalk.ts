import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";

interface StreamMessage {
	text?: { content?: string };
	conversationId?: string;
	senderStaffId?: string;
	senderNick?: string;
	conversationType?: string;
	sessionWebhook?: string;
}

/**
 * 钉钉渠道运行时：官方 dingtalk-stream SDK 建立 Stream 长连接接收机器人消息，
 * 通过消息自带的 sessionWebhook 回复。
 * 凭据：clientId + clientSecret（扫码设备注册或手动绑定获得）。
 */
export class DingtalkRuntime implements ChannelRuntime {
	readonly channel = "dingtalk" as const;
	readonly botId: string;
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private client: unknown = null;
	private running = false;
	private ok = false;
	/** chatId -> sessionWebhook，回复与主动投递共用 */
	private webhooks = new Map<string, string>();

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger) {
		this.bot = bot;
		this.botId = bot.botId;
		this.onMessage = onMessage;
		this.log = log;
	}

	/** 验证凭据：通过 Stream 网关握手校验 */
	async verify(): Promise<string> {
		// Stream 模式下没有独立的"查询机器人信息"接口，直接尝试网关握手
		const res = await fetch("https://api.dingtalk.com/v1.0/gateway/connections/open", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientId: this.bot.credentials.clientId, clientSecret: this.bot.credentials.clientSecret }),
			signal: AbortSignal.timeout(10_000),
		});
		if (!res.ok) throw new Error(`钉钉凭据校验失败: HTTP ${res.status}`);
		return this.bot.name;
	}

	async start(): Promise<void> {
		if (this.running) return;
		let dw: { DWClient?: unknown; TOPIC_ROBOT?: string };
		try {
			// 官方 Stream SDK（optionalDependencies 中的 dingtalk-stream）
			dw = (await import("dingtalk-stream")) as unknown as { DWClient?: unknown; TOPIC_ROBOT?: string };
		} catch {
			throw new Error("缺少 dingtalk-stream 依赖，请执行: npm i dingtalk-stream");
		}
		const DWClient = dw.DWClient as new (opts: Record<string, string>) => {
			registerCallbackListener: (topic: string, cb: (msg: { data: string }) => Promise<unknown>) => void;
			connect: () => Promise<void>;
		};
		const TOPIC_ROBOT = dw.TOPIC_ROBOT ?? "/v1.0/im/bot/messages/get";

		const client = new DWClient({
			clientId: this.bot.credentials.clientId,
			clientSecret: this.bot.credentials.clientSecret,
		});
		client.registerCallbackListener(TOPIC_ROBOT, async (raw: { data: string }) => {
			try {
				const m: StreamMessage = JSON.parse(raw.data);
				const text = m.text?.content?.trim();
				if (!text || !m.conversationId) return;
				if (m.sessionWebhook) this.webhooks.set(m.conversationId, m.sessionWebhook);
				const msg: InboundMessage = {
					route: { channel: "dingtalk", botId: this.bot.botId, chatId: m.conversationId },
					text,
					senderId: m.senderStaffId ?? "",
					senderName: m.senderNick,
					isGroup: m.conversationType === "group",
				};
				this.onMessage(msg);
			} catch (err) {
				this.log.error("[pi-im:dingtalk] 处理消息失败:", err);
			}
			// Stream 回调需要返回 success 应答
			return { status: "success", message: "OK" };
		});
		await client.connect();
		this.client = client;
		this.running = true;
		this.ok = true;
		this.log.info(`[pi-im:dingtalk] 机器人 ${this.bot.botId} 已上线（Stream 长连接）`);
	}

	async send(route: Route, text: string): Promise<void> {
		const webhook = this.webhooks.get(route.chatId);
		if (!webhook) throw new Error("该会话尚未有 webhook（机器人需先收到过该会话的消息）");
		const res = await fetch(webhook, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: { content: text }, msgtype: "text" }),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`钉钉发送失败: HTTP ${res.status}`);
	}

	healthy(): boolean {
		return this.ok && this.running;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.ok = false;
		// dingtalk-stream 的 DWClient 提供 disconnect；不存在时静默
		const c = this.client as { disconnect?: () => Promise<void> } | null;
		if (c?.disconnect) await c.disconnect().catch(() => {});
		this.client = null;
	}
}
