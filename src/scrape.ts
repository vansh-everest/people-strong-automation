import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import type { AppConfig } from "./config.js";
import type { Claim } from "./types.js";
import { JobStore } from "./jobs.js";
import { ClaimStore } from "./storage.js";
import { createContext, ensureSession, isLoggedIn, login } from "./session.js";
import { openTaskTab, openQueue, taskRows } from "./navigation.js";
import { extractClaim, attachmentBytesKey } from "./claims.js";
import { withRetry } from "./util/retry.js";
import { log } from "./logger.js";

export interface ScrapeDeps {
  cfg: AppConfig;
  jobs: JobStore;
  claimStore: ClaimStore;
}

const RETRY = { attempts: 3, baseDelayMs: 1000 };

export async function runScrape(
  jobId: string,
  opts: { stageFilter: string | null; limit: number | null },
  deps: ScrapeDeps
): Promise<void> {
  const { cfg, jobs, claimStore } = deps;
  await jobs.markRunning(jobId);

  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await createContext(browser, cfg);
  const dashboard = await context.newPage();
  const results: Claim[] = [];

  try {
    await withRetry(() => ensureSession(context, dashboard, cfg), {
      ...RETRY,
      onRetry: (a, e) => log.warn("ensureSession retry", { a, e: String(e) }),
    });

    const taskTab = await withRetry(() => openTaskTab(context, cfg), RETRY);
    const pending = await openQueue(taskTab, cfg);

    let rows = await taskRows(taskTab, cfg);
    const total = opts.limit ? Math.min(rows.length, opts.limit) : rows.length;
    if (opts.limit) rows = rows.slice(0, opts.limit);
    await jobs.updateProgress(jobId, { processed: 0, total: total || pending || 0, currentEmployee: null });

    let processed = 0;
    for (const row of rows) {
      let claim: Claim | null = null;
      try {
        // Re-login mid-loop if the session expired.
        if (!(await isLoggedIn(dashboard, cfg))) {
          await login(context, dashboard, cfg);
        }

        const extracted = await withRetry(() => extractClaim(taskTab, row, cfg), RETRY);
        claim = extracted.claim;
        const bytes = extracted.bytes;
        await jobs.updateProgress(jobId, {
          processed,
          total: total || pending || rows.length,
          currentEmployee: claim.employeeCode,
        });

        // Persist the whole claim once; resolve each file's bytes by (head, filename).
        // extractClaim already captured each head's attachments while its panel was rendered.
        await claimStore.persistClaim(jobId, claim, async (att, eh) =>
          bytes.get(attachmentBytesKey(eh.expenseHead, att.filename)) ?? new Uint8Array()
        );
      } catch (err) {
        const msg = String(err);
        log.error("task failed", { err: msg });
        await screenshotOnFailure(taskTab, cfg, claimStore, jobId, processed);
        results.push({
          employeeCode: claim?.employeeCode ?? `unknown-${processed}`,
          employeeName: claim?.employeeName ?? "",
          totalClaimedAmount: claim?.totalClaimedAmount ?? null,
          status: claim?.status ?? null,
          expenseHeads: claim?.expenseHeads ?? [],
          error: msg,
        });
        processed++;
        continue;
      }

      results.push(claim);
      processed++;
      await jobs.updateProgress(jobId, {
        processed,
        total: total || pending || rows.length,
        currentEmployee: claim.employeeCode,
      });
    }

    await jobs.markDone(jobId, results);
    log.info("scrape done", { jobId, claims: results.length });
  } catch (err) {
    log.error("scrape failed", { jobId, err: String(err) });
    await jobs.markFailed(jobId, String(err));
  } finally {
    await context.close();
    await browser.close();
  }
}

async function screenshotOnFailure(
  taskTab: import("playwright").Page,
  cfg: AppConfig,
  claimStore: ClaimStore,
  jobId: string,
  index: number
): Promise<void> {
  try {
    const name = `task-${index}.png`;
    const dir = join(cfg.storageDir, "errors", jobId);
    await mkdir(dir, { recursive: true });
    const buf = await taskTab.screenshot({ fullPage: true });
    await writeFile(join(dir, name), buf);
    await claimStore.uploadErrorScreenshot(jobId, name, new Uint8Array(buf));
  } catch (e) {
    log.warn("screenshot-on-failure failed", { e: String(e) });
  }
}
