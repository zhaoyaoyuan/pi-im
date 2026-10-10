/**
 * Markdown → 飞书卡片（interactive, schema 2.0）转换。
 *
 * 飞书卡片 markdown 元素不支持标题与表格语法：
 * - 标题 `# x` → 加粗行
 * - 表格 → 原生 table 组件（columns/rows）
 * - 其余（加粗/斜体/删除线/链接/行内代码/代码块/引用/列表/分割线）保持原样
 *
 * 转换结果按卡片元素数量与体积分片为多条卡片消息 JSON。
 */

export interface MdBlock {
	type: "md" | "table" | "hr";
	/** md: 转换后的 markdown 文本 */
	content?: string;
	/** table: 表格数据 */
	columns?: { name: string; display_name: string }[];
	rows?: Record<string, string>[];
}

const MAX_ELEMENTS_PER_CARD = 24;
const MAX_CARD_BYTES = 25_000;

/** 把原始 markdown 行流解析为块（表格/分割线/普通内容） */
export function parseMarkdownBlocks(markdown: string): MdBlock[] {
	const lines = markdown.replace(/\r\n/g, "\n").split("\n");
	const blocks: MdBlock[] = [];
	let mdBuffer: string[] = [];
	let codeFence = false;

	const flushMd = () => {
		const text = mdBuffer.join("\n").trim();
		mdBuffer = [];
		if (text) blocks.push({ type: "md", content: text });
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		// 代码块整体保留
		if (/^```/.test(line.trim())) {
			codeFence = !codeFence;
			mdBuffer.push(line);
			continue;
		}
		if (codeFence) {
			mdBuffer.push(line);
			continue;
		}

		// 表格：当前行以 | 开头，且下一行是分隔行（|---|---|）
		if (/^\s*\|/.test(line) && /^\s*\|?[\s:-]+\|?[\s:|-]*$/.test(lines[i + 1] ?? "") && /\|/.test(lines[i + 1] ?? "")) {
			flushMd();
			const header = splitTableRow(line);
			// 跳过分隔行
			i += 1;
			const rows: string[][] = [];
			while (i + 1 < lines.length && /^\s*\|/.test(lines[i + 1] ?? "")) {
				i += 1;
				rows.push(splitTableRow(lines[i]));
			}
			blocks.push(buildTableBlock(header, rows));
			continue;
		}

		// 分割线
		if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			flushMd();
			blocks.push({ type: "hr" });
			continue;
		}

		mdBuffer.push(line);
	}
	flushMd();
	return blocks;
}

/** 拆分一行表格（处理 \| 转义） */
function splitTableRow(line: string): string[] {
	let inner = line.trim();
	if (inner.startsWith("|")) inner = inner.slice(1);
	if (inner.endsWith("|")) inner = inner.slice(0, -1);
	return inner
		.split(/(?<!\\)\|/)
		.map((cell) => cell.replace(/\\\|/g, "|").trim());
}

function buildTableBlock(header: string[], rows: string[][]): MdBlock {
	const columns = header.map((h, idx) => ({
		name: `c${idx}`,
		display_name: stripMarkdown(h) || `列${idx + 1}`,
	}));
	const tableRows = rows.map((row) => {
		const obj: Record<string, string> = {};
		header.forEach((_, idx) => {
			obj[`c${idx}`] = stripMarkdown(row[idx] ?? "");
		});
		return obj;
	});
	return { type: "table", columns, rows: tableRows };
}

/** 表格单元格只支持纯文本：去掉加粗/斜体等标记与链接语法 */
function stripMarkdown(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1($2)")
		.replace(/\*\*(.+?)\*\*/g, "$1")
		.replace(/\*(.+?)\*/g, "$1")
		.replace(/`(.+?)`/g, "$1")
		.trim();
}

/** 卡片 markdown 不支持标题语法：# x → 加粗 */
export function markdownInlineToCard(text: string): string {
	return text.replace(/^#{1,6}\s+(.+)$/gm, "**$1**");
}

/** 组装单张卡片 JSON（schema 2.0） */
function buildCardJson(elements: Record<string, unknown>[]): string {
	return JSON.stringify({
		schema: "2.0",
		config: { wide_screen_mode: true },
		body: { elements },
	});
}

/** 把 markdown 转成一组飞书卡片消息 content（可能分片为多条） */
export function buildFeishuCardMessages(markdown: string): string[] {
	const blocks = parseMarkdownBlocks(markdown);
	if (!blocks.length) return [];

	const cards: string[] = [];
	let elements: Record<string, unknown>[] = [];
	let bytes = 0;

	const flush = () => {
		if (elements.length) {
			cards.push(buildCardJson(elements));
			elements = [];
			bytes = 0;
		}
	};

	const push = (element: Record<string, unknown>, approxBytes: number) => {
		if (elements.length >= MAX_ELEMENTS_PER_CARD || bytes + approxBytes > MAX_CARD_BYTES) {
			flush();
		}
		elements.push(element);
		bytes += approxBytes;
	};

	for (const block of blocks) {
		if (block.type === "hr") {
			if (elements.length === 0) continue; // 卡片开头不放分割线
			push({ tag: "hr" }, 8);
			continue;
		}
		if (block.type === "table") {
			push(
				{
					tag: "table",
					page_size: 10,
					row_height: "low",
					columns: block.columns,
					rows: block.rows,
				},
				JSON.stringify(block.rows ?? []).length,
			);
			continue;
		}
		// md 块
		push({ tag: "markdown", content: markdownInlineToCard(block.content ?? "") }, block.content?.length ?? 0);
	}
	flush();
	return cards;
}
