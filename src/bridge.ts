/**
 * IM ↔ pi 桥：入站消息注入 pi 会话（空闲时新回合，流式时 steer 插话），
 * 回合结束后把最终助手回复路由回发起聊天的 IM 渠道。
 */
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { IM_HELP_TEXT, parseInbound } from "./commands.js";
import { DeliveryRegistry } from "./delivery.js";
import { routeKey, setLastRoute } from "./store.js";
import type { ChannelRuntime, InboundMessage, Route, RuntimeLogger } from "./types.js";

export class ImBridge {
	/** 当前回合的消息来源路由；null 表示回合由 TUI 本地用户发起 */
	private activeRoute: Route | null = null;
	/** 最近一次事件/命令上下文（用于 isIdle / abort / notify） */
	private ctx: ExtensionContext | null = null;
	/** 命令上下文（含 newSession，仅命令处理器可获取） */
	private commandCtx: ExtensionCommandContext | null = null;
	private runtimes = new Map<string, ChannelRuntime>();
	/** 主动投递目标记忆：每次入站消息更新（供 im_send 等投递方使用） */
	readonly deliveryRegistry = new DeliveryRegistry();

	constructor(
		private readonly pi: ExtensionAPI,
		private readonly log: RuntimeLogger,
	) {}

	/** 注册 pi 生命周期事件 */
	wire(): void {
		this.pi.on("session_start", () => {
			this.activeRoute = null;
		});

		this.pi.on("session_info_changed", (_event, ctx) => {
			this.ctx = ctx;
		});

		this.pi.on("agent_start", (_event, ctx) => {
			this.ctx = ctx;
		});

		this.pi.on("agent_end", (event, ctx) => {
			this.ctx = ctx;
			void this.deliverReply(event);
		});
	}

	/** 命令处理器调用：捕获命令上下文（唯一能拿到 newSession 的地方） */
	captureCommandContext(ctx: ExtensionCommandContext): void {
		this.commandCtx = ctx;
		this.ctx = ctx;
	}

	registerRuntime(runtime: ChannelRuntime): void {
		this.runtimes.set(`${runtime.channel}:${runtime.botId}`, runtime);
	}

	unregisterRuntime(runtime: ChannelRuntime): void {
		this.runtimes.delete(`${runtime.channel}:${runtime.botId}`);
	}

	listRuntimes(): ChannelRuntime[] {
		return [...this.runtimes.values()];
	}

	isIdle(): boolean {
		return this.ctx?.isIdle?.() ?? true;
	}

	/** 渠道运行时回调：IM 消息入口 */
	handleInbound(msg: InboundMessage): void {
		void this.handleInboundAsync(msg).catch((err) => this.log.error("[pi-im] 入站处理失败:", err));
	}

	private async handleInboundAsync(msg: InboundMessage): Promise<void> {
		const parsed = parseInbound(msg);
		this.deliveryRegistry.remember(msg);
		const runtime = this.runtimes.get(`${msg.route.channel}:${msg.route.botId}`);
		const reply = async (text: string) => {
			try {
				await runtime?.send(msg.route, text);
			} catch (err) {
				this.log.warn("[pi-im] 回复发送失败:", err);
			}
		};

		switch (parsed.kind) {
			case "help":
				await reply(IM_HELP_TEXT);
				return;
			case "status": {
				const bots = this.listRuntimes()
					.map((r) => `- ${r.channel}:${r.botId} ${r.healthy() ? "✅ 在线" : "❌ 离线"}`)
					.join("\n");
				await reply(
					`pi-im 状态：\n${bots || "（无在线机器人）"}\n当前会话来源: ${this.activeRoute ? routeKey(this.activeRoute) : "TUI 本地"}`,
				);
				return;
			}
			case "new":
				await this.startNewSession(msg);
				return;
			case "stop":
				this.ctx?.abort();
				await reply("已请求停止当前任务。");
				return;
			case "steer":
			case "text":
				break;
			case "unknown":
				await reply(`未知命令 ${parsed.command}，发送 /help 查看支持的命令。`);
				return;
		}

		const text = parsed.text;
		if (!text) return;

		// 记录来源路由：本回合的回复将发回该聊天
		this.activeRoute = msg.route;
		await setLastRoute(routeKey(msg.route));

		try {
			if (this.isIdle()) {
				await this.pi.sendUserMessage(text);
			} else {
				// 流式中：作为插话注入当前任务
				await this.pi.sendUserMessage(text, { deliverAs: "steer" });
				await reply("已作为补充指令加入当前任务。");
			}
		} catch (err) {
			this.log.error("[pi-im] 注入消息失败:", err);
			await reply(`消息投递失败: ${(err as Error).message}`);
			this.activeRoute = null;
		}
	}

	private async startNewSession(msg: InboundMessage): Promise<void> {
		const runtime = this.runtimes.get(`${msg.route.channel}:${msg.route.botId}`);
		if (!this.commandCtx) {
			await runtime?.send(msg.route, "尚无可用会话控制上下文，请先在 pi TUI 中运行一次 /im 命令。");
			return;
		}
		try {
			const result = await this.commandCtx.newSession();
			await runtime?.send(msg.route, result.cancelled ? "已取消新会话。" : "已开启全新会话 ✅");
		} catch (err) {
			await runtime?.send(msg.route, `新会话失败: ${(err as Error).message}`);
		}
	}

	/** 回合结束：把最终助手文本路由回来源聊天 */
	private async deliverReply(event: { messages?: unknown[] }): Promise<void> {
		const route = this.activeRoute;
		this.activeRoute = null;
		if (!route) return; // TUI 本地发起的回合

		const runtime = this.runtimes.get(`${route.channel}:${route.botId}`);
		if (!runtime) return;

		const text = lastAssistantText(event.messages ?? []);
		if (!text) return;
		try {
			await runtime.send(route, text);
		} catch (err) {
			this.log.error("[pi-im] 回复投递失败:", err);
		}
	}
}

/** 从 agent_end 的消息列表提取最后一条助手文本 */
export function lastAssistantText(messages: unknown[]): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; content?: unknown; text?: string };
		if (m?.role !== "assistant") continue;
		if (Array.isArray(m.content)) {
			const texts = m.content
				.map((c) =>
					c && typeof c === "object" && (c as { type?: string }).type === "text"
						? (c as { text?: string }).text
						: null,
				)
				.filter((t): t is string => typeof t === "string" && t.length > 0);
			if (texts.length) return texts.join("\n");
		} else if (typeof m.text === "string" && m.text) {
			return m.text;
		}
	}
	return null;
}
