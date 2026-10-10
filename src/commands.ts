import type { InboundMessage } from "./types.js";

/** IM 侧内置命令解析结果 */
export type ParsedCommand =
	| { kind: "text"; text: string }
	| { kind: "new" }
	| { kind: "stop" }
	| { kind: "status" }
	| { kind: "help" }
	| { kind: "steer"; text: string }
	| { kind: "unknown"; command: string };

const COMMANDS = new Set(["new", "stop", "status", "help", "steer", "clear", "compact"]);

export function parseInbound(msg: InboundMessage): ParsedCommand {
	const text = msg.text.trim();
	if (!text.startsWith("/")) return { kind: "text", text };
	const parts = text.split(/\s+/);
	const cmd = parts[0].slice(1).toLowerCase();
	if (!COMMANDS.has(cmd)) return { kind: "unknown", command: parts[0] };
	switch (cmd) {
		case "new":
		case "clear":
			return { kind: "new" };
		case "stop":
			return { kind: "stop" };
		case "status":
			return { kind: "status" };
		case "help":
			return { kind: "help" };
		case "compact":
			return { kind: "new" };
		case "steer":
			return { kind: "steer", text: parts.slice(1).join(" ") };
	}
	return { kind: "unknown", command: parts[0] };
}

export const IM_HELP_TEXT = [
	"pi-im 机器人命令：",
	"/new — 开启全新会话（下一条消息不再携带历史）",
	"/stop — 立即停止当前正在运行的任务",
	"/status — 查看连接与会话状态",
	"/steer <补充指令> — 向正在运行的任务插入补充指令",
	"/help — 显示本帮助",
	"普通消息直接发送即可，AI 回复会自动发回本聊天。",
].join("\n");
