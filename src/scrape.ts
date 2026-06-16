import { chromium } from "playwright";
import type { AppConfig } from "./config.js";
import type { ClaimRecord } from "./types.js";
import { JobStore } from "./jobs.js";
import { createContext, ensureSession } from "./session.js";
import { openTaskTab, openQueue, goBackToList, pageCount, gotoPage } from "./navigation.js";
import { extractClaimRecords, openClaim } from "./claims.js";
import { captureAttachments } from "./attachments.js";
import { withRetry } from "./util/retry.js";
import { log } from "./logger.js";

export interface ScrapeDeps {
  cfg: AppConfig;
  jobs: JobStore;
}

const RETRY = { attempts: 3, baseDelayMs: 1000 };

type ScrapeOutcome = "ok" | "fail" | "norow";

/**
 * Navigate to a claim's page, open it, extract its records (pushed into `results`), and
 * return to the list. Returns:
 *  - "ok"    extracted successfully
 *  - "fail"  a real claim that errored (caller should retry it)
 *  - "norow" the index doesn't exist on that page (e.g. a stale over-count on the short
 *            last page) — not a real claim, so it must not be counted or retried.
 * Always returns to the list (detail-aware BACK) so the caller can proceed.
 */
async function scrapeAt(
  taskTab: import("playwright").Page,
  cfg: AppConfig,
  page: number,
  index: number,
  results: ClaimRecord[]
): Promise<ScrapeOutcome> {
  try {
    await gotoPage(taskTab, page);
    // Guard against a phantom index (a short last page, or a brief stale row over-count):
    // require the specific row to actually become visible, else it's not a real claim.
    try {
      await taskTab.locator(cfg.selectors.TASK_LINK).nth(index).waitFor({ state: "visible", timeout: 4000 });
    } catch {
      return "norow";
    }
    await withRetry(() => openClaim(taskTab, cfg, index), RETRY);
    const recs = await extractClaimRecords(taskTab);
    // Download attachments and attach by expense-head index (Max 1 per head). With a
    // single file it lands on the first record; extra files map 1:1 by position.
    const atts = await captureAttachments(taskTab, cfg);
    recs.forEach((r, k) => {
      const a = atts[k];
      if (a) {
        r.attachment_filename = a.filename;
        r.attachment_url = a.dataUrl;
      }
    });
    results.push(...recs);
    return "ok";
  } catch (err) {
    // If the row no longer exists, this was a transient phantom (a stale paginator
    // render briefly showed an extra row) — not a real claim. Treat as end-of-page,
    // quietly, rather than a failure to retry.
    const stillThere = await taskTab
      .locator(cfg.selectors.TASK_LINK)
      .nth(index)
      .isVisible()
      .catch(() => false);
    if (!stillThere) return "norow";
    log.error("claim failed", { page, index, err: String(err) });
    return "fail";
  } finally {
    await goBackToList(taskTab, cfg).catch(() => {});
  }
}

/**
 * Full scrape: login → deeplink-bridge task tab → open the Reimbursement queue →
 * iterate task rows across pages → open each claim and extract its expense-head
 * records → accumulate into the job's results (flat ClaimRecord[]).
 * One bad claim never aborts the job. `limit` caps the number of CLAIMS processed.
 */
export async function runScrape(
  jobId: string,
  opts: { stageFilter: string | null; limit: number | null },
  deps: ScrapeDeps
): Promise<void> {
  const { cfg, jobs } = deps;
  const browser = await chromium.launch({ headless: cfg.headless });
  const context = await createContext(browser, cfg);
  const dashboard = await context.newPage();
  const results: ClaimRecord[] = [];

  try {
    await withRetry(() => ensureSession(context, dashboard, cfg), {
      ...RETRY,
      onRetry: (a, e) => log.warn("ensureSession retry", { a, e: String(e) }),
    });

    const taskTab = await withRetry(() => openTaskTab(context, cfg), RETRY);
    const pending = await openQueue(taskTab, cfg);
    const limit = opts.limit ?? null;
    const pages = await pageCount(taskTab);
    jobs.setProgress(jobId, 0, limit ?? pending ?? 0);

    // Opening a claim replaces the list and BACK resets the paginator to page 1, so we
    // explicitly navigate to each claim's page (1-based) before opening it.
    let processed = 0; // claims processed (not records)
    let stop = false;
    let failed: { page: number; index: number }[] = [];
    for (let p = 1; p <= pages && !stop; p++) {
      for (let i = 0; !stop; i++) {
        if (limit && processed >= limit) {
          stop = true;
          break;
        }
        const outcome = await scrapeAt(taskTab, cfg, p, i, results);
        if (outcome === "norow") break; // page exhausted
        if (outcome === "fail") failed.push({ page: p, index: i });
        processed++;
        jobs.setProgress(jobId, processed, limit ?? pending ?? 0);
      }
    }

    // Retry pass: re-scrape any claims that failed in the main pass. The queue is
    // unchanged (we never approve/reject), so (page, index) still identifies the claim.
    for (let round = 1; failed.length && round <= 2; round++) {
      log.info("retry pass for failed claims", { round, count: failed.length });
      const stillFailed: { page: number; index: number }[] = [];
      for (const pos of failed) {
        const outcome = await scrapeAt(taskTab, cfg, pos.page, pos.index, results);
        if (outcome === "fail") stillFailed.push(pos); // "ok"/"norow" → drop
      }
      failed = stillFailed;
    }
    if (failed.length) {
      log.warn("claims still failing after retries", { count: failed.length, failed });
    }

    jobs.markDone(jobId, results);
    log.info("scrape done", {
      jobId,
      claims: processed,
      records: results.length,
      stillFailed: failed.length,
      pages,
    });
  } catch (err) {
    log.error("scrape failed", { jobId, err: String(err) });
    jobs.markError(jobId, String(err));
  } finally {
    await context.close();
    await browser.close();
  }
}
