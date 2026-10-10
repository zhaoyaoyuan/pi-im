/** 渠道标识 */
export type ChannelId =
	| "telegram"
	| "feishu"
	| "dingtalk"
	| "wecom"
	| "qq"
	| "slack"
	| "discord"
	| "whatsapp"
	| "imessage"
	| "weixin";

/** 一个 IM 消息的来源路由：渠道 + 机器人 + 聊天 */
export interface Route {
	channel: ChannelId;
	/** 渠道内机器人唯一标识（telegram: username；feishu: app_id；dingtalk: client_id） */
	botId: string;
	/** 聊天标识（telegram: chat.id；feishu: chat_id；dingtalk: conversationId） */
	chatId: string;
}

/** 归一化后的入站消息 */
export interface InboundMessage {
	route: Route;
	text: string;
	senderId: string;
	senderName?: string;
	/** 群聊消息 */
	isGroup: boolean;
}

/** 机器人配置（含凭据，只落盘不外传） */
export interface BotConfig {
	channel: ChannelId;
	botId: string;
	name: string;
	/** 渠道凭据：telegram { token }；feishu { appId, appSecret }；dingtalk { clientId, clientSecret } */
	credentials: Record<string, string>;
	/** 是否启用 */
	enabled: boolean;
}

/** 渠道运行时接口：所有渠道适配器实现该接口 */
export interface ChannelRuntime {
	readonly channel: ChannelId;
	readonly botId: string;
	/** 启动长连接/轮询 */
	start(): Promise<void>;
	/** 停止并清理 */
	stop(): Promise<void>;
	/** 向指定聊天发送文本 */
	send(route: Route, text: string): Promise<void>;
	/** 连接是否健康 */
	healthy(): boolean;
}

/** 渠道适配器收到消息后的回调 */
export type InboundHandler = (msg: InboundMessage) => void;

export interface RuntimeLogger {
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
}

/** 单条消息发送长度上限（各渠道按能力截断/分段） */
export function chunkText(text: string, max = 3500): string[] {
	if (text.length <= max) return [text];
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		// 优先在换行处切
		let cut = rest.lastIndexOf("\n", max);
		if (cut < max * 0.5) cut = max;
		parts.push(rest.slice(0, cut));
		rest = rest.slice(cut).replace(/^\n+/, "");
	}
	if (rest) parts.push(rest);
	return parts;
}
