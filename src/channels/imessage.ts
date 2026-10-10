import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BotConfig, ChannelRuntime, InboundHandler, InboundMessage, RuntimeLogger, Route } from "../types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_DB_PATH = `${process.env.HOME ?? ""}/Library/Messages/chat.db`;
/** 机器人回复前缀：用于过滤自身回声 */
const BOT_REPLY_PREFIX = "🤖 pi-im\n";

/**
 * iMessage 渠道运行时（仅 macOS）：
 * - 收：轮询 ~/Library/Messages/chat.db（sqlite3 -json，需完全磁盘访问权限）
 * - 发：osascript 控制 Messages.app（需自动化权限）
 * 无任何外部服务与凭据；botId 固定为 "local"。
 */
export class IMessageRuntime implements ChannelRuntime {
	readonly channel = "imessage" as const;
	readonly botId = "local";
	private readonly bot: BotConfig;
	private readonly onMessage: InboundHandler;
	private readonly log: RuntimeLogger;
	private timer: ReturnType<typeof setInterval> | null = null;
	private running = false;
	private ok = false;
	private cursor = 0;
	private dbPath: string;

	constructor(bot: BotConfig, onMessage: InboundHandler, log: RuntimeLogger, dbPath = DEFAULT_DB_PATH) {
		this.bot = bot;
		this.onMessage = onMessage;
		this.log = log;
		this.dbPath = dbPath;
	}

	/** 验证：平台 + 数据库 + 自动化权限 */
	async verify(): Promise<string> {
		if (process.platform !== "darwin") {
			throw new Error("iMessage 渠道仅支持 macOS");
		}
		try {
			await execFileAsync("/usr/bin/sqlite3", ["-json", this.dbPath, "SELECT 1 AS ok LIMIT 1;"], { timeout: 10_000 });
		} catch (err) {
			const stderr = String((err as { stderr?: string }).stderr ?? err);
			if (/authorization denied|not authorized|unable to open database/i.test(stderr)) {
				throw new Error("需要「完全磁盘访问」权限才能读取 chat.db（系统设置 → 隐私与安全性）");
			}
			throw err;
		}
		try {
			await execFileAsync("/usr/bin/osascript", ["-e", 'tell application "Messages" to get name'], { timeout: 10_000 });
		} catch (err) {
			const stderr = String((err as { stderr?: string }).stderr ?? err);
			if (/not authorized|(-1743)|assistive/i.test(stderr)) {
				throw new Error("需要允许自动化控制「信息」App（系统设置 → 隐私与安全性 → 自动化）");
			}
			throw err;
		}
		return "iMessage";
	}

	async start(): Promise<void> {
		if (this.running) return;
		this.cursor = await this.latestRowId();
		this.running = true;
		this.ok = true;
		// 每 2 秒轮询一次新消息
		this.timer = setInterval(() => {
			void this.poll().catch((err) => this.log.warn("[pi-im:imessage] 轮询失败:", err));
		}, 2_000);
		this.log.info(`[pi-im:imessage] 已上线（本机 Messages.app，起始 ROWID=${this.cursor}）`);
	}

	private async latestRowId(): Promise<number> {
		const query = `SELECT COALESCE(MAX(m.ROWID), 0) AS rowid
			FROM message m
			JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			JOIN chat c ON c.ROWID = cmj.chat_id
			WHERE c.service_name = 'iMessage';`;
		const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-json", this.dbPath, query], { timeout: 10_000 });
		const rows = JSON.parse(stdout || "[]") as { rowid?: number }[];
		return Number(rows[0]?.rowid ?? 0);
	}

	private async poll(): Promise<void> {
		const query = `SELECT m.ROWID AS rowid, m.guid AS guid, m.text AS text,
			h.id AS sender, c.guid AS chatGuid,
			datetime((m.date / 1000000000) + 978307200, 'unixepoch') AS receivedAt
			FROM message m
			JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
			JOIN chat c ON c.ROWID = cmj.chat_id
			LEFT JOIN handle h ON h.ROWID = m.handle_id
			WHERE m.ROWID > ${this.cursor} AND m.is_from_me = 0
				AND m.text IS NOT NULL AND m.text != ''
				AND c.service_name = 'iMessage'
			ORDER BY m.ROWID ASC LIMIT 50;`;
		const { stdout } = await execFileAsync("/usr/bin/sqlite3", ["-json", this.dbPath, query], { timeout: 10_000 });
		const rows = JSON.parse(stdout || "[]") as {
			rowid: number;
			guid: string;
			text: string;
			sender: string | null;
			chatGuid: string;
		}[];
		for (const row of rows) {
			this.cursor = Math.max(this.cursor, row.rowid);
			const text = row.text.trim();
			if (!text || text.startsWith(BOT_REPLY_PREFIX)) continue;
			const sender = row.sender ?? row.chatGuid;
			const msg: InboundMessage = {
				route: { channel: "imessage", botId: this.botId, chatId: row.chatGuid },
				text,
				senderId: sender,
				isGroup: false,
			};
			this.onMessage(msg);
		}
	}

	async send(route: Route, text: string): Promise<void> {
		// chatGuid 形如 "iMessage;-SenderPhone"，收件人取分号后一段
		const recipient = route.chatId.includes(";") ? route.chatId.split(";").pop()! : route.chatId;
		const script = `tell application "Messages"
			set serviceList to every service whose service type = iMessage
			if (count of serviceList) is 0 then error "No iMessage service is available"
			set targetService to item 1 of serviceList
			set targetBuddy to buddy ${JSON.stringify(recipient)} of targetService
			send ${JSON.stringify(`${BOT_REPLY_PREFIX}${text}`)} to targetBuddy
		end tell`;
		await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 15_000 });
	}

	healthy(): boolean {
		return this.ok && this.running;
	}

	async stop(): Promise<void> {
		this.running = false;
		this.ok = false;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
	}
}
