import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * 展示扫码绑定二维码：
 * 1. 终端 ASCII 二维码通过 notify 展示（等宽字体下可扫）；
 * 2. 同时生成 PNG 并用系统默认看图工具打开，作为大图兜底。
 */
export async function showQrOverlay(
	ctx: ExtensionCommandContext,
	title: string,
	url: string,
): Promise<void> {
	// 终端 ASCII 版（small 模式用下半块字符，密度足够被手机扫出）
	let ascii = "";
	try {
		ascii = await QRCode.toString(url, { type: "terminal", small: true });
	} catch {
		ascii = "";
	}

	const lines = [title, "", url, ""];
	if (ascii) lines.push(ascii);
	ctx.ui.notify(lines.join("\n"), "info");

	// PNG 兜底：保存到临时文件并打开
	try {
		const file = join(tmpdir(), `pi-im-qr-${Date.now()}.png`);
		await QRCode.toFile(file, url, { width: 512, margin: 2 });
		const opener =
			process.platform === "darwin"
				? "open"
				: process.platform === "win32"
					? "explorer"
					: "xdg-open";
		spawn(opener, [file], { stdio: "ignore", detached: true }).unref();
	} catch {
		// 打不开也不影响扫码主路径
	}
}

/**
 * 打开一张远程图片（微信 iLink 返回的是二维码图片 URL，不是可编码内容）。
 * 先下载到临时文件再打开，避免浏览器直连受限。
 */
export async function openImageUrl(ctx: ExtensionCommandContext, title: string, url: string): Promise<void> {
	ctx.ui.notify(`${title}\n\n${url}`, "info");
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const buf = Buffer.from(await res.arrayBuffer());
		const file = join(tmpdir(), `pi-im-qr-${Date.now()}.png`);
		await writeFile(file, buf);
		const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
		spawn(opener, [file], { stdio: "ignore", detached: true }).unref();
	} catch (err) {
		ctx.ui.notify(`自动打开二维码图片失败（${(err as Error).message}），请手动打开上方 URL 扫码。`, "warning");
	}
}
