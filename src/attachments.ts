import type { Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import type { Attachment } from "./types.js";
import { log } from "./logger.js";

export interface DownloadedAttachment {
  meta: Attachment;
  bytes: Uint8Array;
}

/**
 * For each attachment link in the currently-rendered expense-head panel:
 * capture the filename (link text), click, and grab the downloaded bytes.
 * PrimeFaces attachment URLs are session-bound, so we download bytes now.
 */
export async function captureAttachments(
  taskTab: Page,
  cfg: AppConfig
): Promise<DownloadedAttachment[]> {
  const links = taskTab.locator(cfg.selectors.ATTACHMENT_LINK);
  const count = await links.count();
  const out: DownloadedAttachment[] = [];

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const filename = (await link.innerText().catch(() => `attachment-${i}`)).trim();
    try {
      const result = await captureOne(taskTab, link, filename);
      out.push(result);
    } catch (err) {
      log.warn("attachment capture failed", { filename, err: String(err) });
    }
  }
  return out;
}

async function captureOne(
  taskTab: Page,
  link: Locator,
  filename: string
): Promise<DownloadedAttachment> {
  // Capture the response bytes AND the download event; whichever yields bytes wins.
  let responseUrl: string | null = null;
  let responseBytes: Uint8Array | null = null;

  const onResponse = async (resp: import("playwright").Response) => {
    const ct = resp.headers()["content-type"] ?? "";
    const cd = resp.headers()["content-disposition"] ?? "";
    if (cd.includes("attachment") || /application\/(pdf|octet-stream)|image\//.test(ct)) {
      try {
        responseBytes = new Uint8Array(await resp.body());
        responseUrl = resp.url();
      } catch {
        /* body not available (e.g. redirect) — ignore */
      }
    }
  };
  taskTab.on("response", onResponse);

  let bytes: Uint8Array;
  try {
    const [download] = await Promise.all([
      taskTab.waitForEvent("download", { timeout: 30000 }).catch(() => null),
      link.click(),
    ]);

    if (download) {
      const stream = await download.createReadStream();
      bytes = await streamToBytes(stream);
      responseUrl = responseUrl ?? download.url();
    } else if (responseBytes) {
      bytes = responseBytes;
    } else {
      throw new Error("no download event and no response body captured");
    }
  } finally {
    taskTab.off("response", onResponse);
  }

  return {
    meta: { filename, storagePath: "", sourceResponseUrl: responseUrl, ocrStatus: "pending" },
    bytes,
  };
}

async function streamToBytes(
  stream: NodeJS.ReadableStream | null
): Promise<Uint8Array> {
  if (!stream) throw new Error("empty download stream");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}
