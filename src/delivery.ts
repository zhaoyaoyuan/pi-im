/**
 * pi-im 主动投递服务：把渠道发送能力以 pi 工具形式暴露给其他扩展 / agent 使用。
 *
 * 工具：
 * - im_bots   列出在线机器人及其最近聊天（可选投递目标）
 * - im_send   向指定机器人 + 目标（chatId）发送文本；未指定目标时发送到该机器人最近一次收过消息的聊天
 *
 * 设计对应 dsh-im 的"主动投递"：消费方（如 daily-news 定时任务）只负责生成内容，
 * 投递路由、凭据、渠道协议、卡片渲染全部由 pi-im 渠道运行时承担。
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routeKey } from "./store.js";
import type { ChannelRuntime, Route } from "./types.js";

export interface DeliveryTarget {
	route: Route;
	/** 目标描述（来自最近一次入站消息） */
	label?: string;
	lastInboundAt: number;
}

/** 最近聊天目标记忆（进程内，够用：投递目标一般在同一 Host 生命周期内使用） */
export class DeliveryRegistry {
	private lastTargets = new Map<string, DeliveryTarget>();
	private seq = 0;

	remember(msg: { route: Route; senderName?: string }): void {
		// 毫秒时间戳 ×1000 + 单调序号：同毫秒内后到的消息也能正确排新
		this.lastTargets.set(routeKey(msg.route), {
			route: msg.route,
			label: msg.senderName ? `${msg.route.chatId} (${msg.senderName})` : msg.route.chatId,
			lastInboundAt: Date.now() * 1000 + ++this.seq,
		});
	}

	forBot(channel: string, botId: string): DeliveryTarget | null {
		const prefix = `${channel}:${botId}:`;
		let best: DeliveryTarget | null = null;
		for (const t of this.lastTargets.values()) {
			if (routeKey(t.route).startsWith(prefix) && (!best || t.lastInboundAt > best.lastInboundAt)) {
				best = t;
			}
		}
		return best;
	}

	list(): DeliveryTarget[] {
		return [...this.lastTargets.values()].sort((a, b) => b.lastInboundAt - a.lastInboundAt);
	}
}

export function registerDeliveryTools(pi: ExtensionAPI, opts: { runtimes: () => ChannelRuntime[]; registry: DeliveryRegistry }): void {
	const { runtimes, registry } = opts;

	pi.registerTool({
		name: "im_bots",
		label: "IM 机器人列表",
		description:
			"列出 pi-im 当前在线的 IM 机器人（飞书/微信/钉钉/企微/QQ/Slack/Discord/Telegram/WhatsApp 等）及其可投递的最近聊天目标。发送消息前先用它获取 channel/botId/chatId。",
		parameters: Type.Object({}),
		execute: async () => {
			const bots = runtimes().map((r) => {
				const target = registry.forBot(r.channel, r.botId);
				return {
					channel: r.channel,
					botId: r.botId,
					online: r.healthy(),
					lastTarget: target ? { chatId: target.route.chatId, label: target.label } : null,
				};
			});
			const text = bots.length
				? bots
						.map(
							(b) =>
								`- [${b.channel}] ${b.botId} ${b.online ? "在线" : "离线"}${
									b.lastTarget ? ` · 最近聊天: ${b.lastTarget.chatId}${b.lastTarget.label ? ` (${b.lastTarget.label})` : ""}` : " · 暂无投递目标（需先收到过消息）"
								}`,
						)
						.join("\n")
				: "当前没有在线的 IM 机器人（用 /im bind 绑定）";
			return { content: [{ type: "text", text }], details: { bots }, structuredContent: { bots } };
		},
	});

	pi.registerTool({
		name: "im_send",
		label: "IM 主动投递",
		description:
			"向指定的 IM 机器人聊天主动发送文本消息（markdown 会在支持的渠道渲染为富文本，如飞书卡片）。参数：channel+botId 定位机器人，chatId 为目标聊天（用 im_bots 查询）；只提供一个在线机器人且要发到它最近聊天时，可全部省略。",
		parameters: Type.Object({
			text: Type.String({ description: "要发送的文本，支持 markdown" }),
			channel: Type.Optional(Type.String({ description: "渠道 id，如 feishu / weixin / dingtalk / telegram" })),
			botId: Type.Optional(Type.String({ description: "机器人 id（im_bots 返回）" })),
			chatId: Type.Optional(Type.String({ description: "目标聊天 id（im_bots 返回的最近聊天）" })),
		}),
		execute: async (_id, params) => {
			const all = runtimes();
			if (!all.length) {
				return { content: [{ type: "text", text: "没有在线的 IM 机器人，请先 /im bind 绑定。" }], details: { sent: false } };
			}
			let runtime: ChannelRuntime | undefined;
			if (params.channel && params.botId) {
				runtime = all.find((r) => r.channel === params.channel && r.botId === params.botId);
				if (!runtime) return { content: [{ type: "text", text: `未找到机器人 ${params.channel}:${params.botId}` }], details: { sent: false } };
			} else if (all.length === 1) {
				runtime = all[0];
			} else {
				const online = all.filter((r) => r.healthy());
				if (online.length === 1) runtime = online[0];
				else {
					return {
						content: [{ type: "text", text: `有 ${all.length} 个机器人，请用 im_bots 查询后指定 channel 和 botId。` }],
						details: { sent: false },
					};
				}
			}

			// 目标：显式 chatId > 该机器人最近聊天
			let chatId = params.chatId;
			if (!chatId) {
				const last = registry.forBot(runtime.channel, runtime.botId);
				if (!last) {
					return {
						content: [{ type: "text", text: `${runtime.channel}:${runtime.botId} 尚无投递目标（机器人需先收到过聊天消息），请提供 chatId。` }],
						details: { sent: false },
					};
				}
				chatId = last.route.chatId;
			}

			const route: Route = { channel: runtime.channel, botId: runtime.botId, chatId };
			try {
				await runtime.send(route, params.text);
				const details: { sent: boolean; route?: Route } = { sent: true, route };
				return {
					content: [{ type: "text", text: `已发送到 ${runtime.channel}:${runtime.botId} → ${chatId}` }],
					details,
					structuredContent: { sent: true, route },
				};
			} catch (err) {
				const details: { sent: boolean; route?: Route } = { sent: false };
				return { content: [{ type: "text", text: `发送失败: ${(err as Error).message}` }], details };
			}
		},
	});
}
