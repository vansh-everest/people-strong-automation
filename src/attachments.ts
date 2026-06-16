import type { Page } from "playwright";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

export interface DownloadedAttachment {
  filename: string;
  /** base64 data: URL of the file bytes, or null if the download failed. */
  dataUrl: string | null;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  txt: "text/plain",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

function mimeFor(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * Capture the claim's attachments from the PrimeFaces datalist on the rendered detail.
 * Each item is an <a> whose text is "filename (size)" and whose click triggers a JSF
 * file download. We download the bytes and return them as base64 data: URLs (the worker
 * has no storage; the platform stores the data URL in reimbursement_rows.attachment_url).
 */
export async function captureAttachments(
  taskTab: Page,
  cfg: AppConfig
): Promise<DownloadedAttachment[]> {
  const links = taskTab.locator(cfg.selectors.ATTACHMENT_LINK);
  const count = await links.count().catch(() => 0);
  const out: DownloadedAttachment[] = [];

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    // textContent (not innerText) because the attachment list lives in a hidden
    // multiDataforUpload form — innerText would return "" for hidden nodes.
    const raw = ((await link.textContent().catch(() => "")) ?? "").trim();
    if (!raw || /No records found/i.test(raw)) continue;
    // Strip the trailing size, e.g. "Receipt.pdf (171 K)" -> "Receipt.pdf".
    const filename = raw.replace(/\s*\(\s*[\d.]+\s*[KMGT]?B?\s*\)\s*$/i, "").trim() || raw;

    try {
      const [download] = await Promise.all([
        taskTab.waitForEvent("download", { timeout: 30000 }),
        // DOM click (not Playwright .click()) — the anchor is hidden, so actionability
        // checks would hang; el.click() runs the JSF onclick that streams the file.
        link.evaluate((el) => (el as HTMLElement).click()),
      ]);
      const buf = await streamToBuffer(await download.createReadStream());
      out.push({ filename, dataUrl: `data:${mimeFor(filename)};base64,${buf.toString("base64")}` });
      log.info("attachment captured", { filename, bytes: buf.length });
    } catch (err) {
      log.warn("attachment download failed", { filename, err: String(err) });
      out.push({ filename, dataUrl: null });
    }
  }
  return out;
}
