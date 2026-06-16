import { chromium } from "playwright";
import type { AppConfig } from "./config.js";
import type { ClaimRecord } from "./types.js";
import { JobStore } from "./jobs.js";
import { createContext, ensureSession } from "./session.js";
import { openTaskTab, openQueue, rowCount, goBackToList } from "./navigation.js";
import { extractClaimRecords, openClaim } from "./claims.js";
import { withRetry } from "./util/retry.js";
import { log } from "./logger.js";

export interface ScrapeDeps {
  cfg: AppConfig;
  jobs: JobStore;
}

const RETRY = { attempts: 3, baseDelayMs: 1000 };

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

    const pageRows = await rowCount(taskTab, cfg);
    const target = limit ? Math.min(limit, pageRows) : pageRows;
    jobs.setProgress(jobId, 0, limit ?? pending ?? pageRows);

    let processed = 0; // claims processed (not records)
    for (let i = 0; i < target; i++) {
      try {
        // Opening a claim replaces the list; extract then go back for the next row.
        await withRetry(() => openClaim(taskTab, cfg, i), RETRY);
        const recs = await extractClaimRecords(taskTab);
        results.push(...recs);
      } catch (err) {
        log.error("claim failed", { index: i, err: String(err) });
        // Skip this claim; continue with the rest.
      }
      processed++;
      jobs.setProgress(jobId, processed, limit ?? pending ?? pageRows);

      if (i < target - 1) {
        try {
          await goBackToList(taskTab, cfg);
        } catch (err) {
          log.error("could not return to task list; stopping", { err: String(err) });
          break;
        }
      }
    }

    // NOTE: only the first queue page (~14 rows) is processed. Paginating to the full
    // pending set is a follow-up: opening a claim resets the list, so cross-page
    // iteration must re-navigate to the right page after each BACK (verify live).
    if (!limit && pending && pending > pageRows) {
      log.warn("processed first page only; pagination across pages is a follow-up", {
        processedRows: pageRows,
        pending,
      });
    }

    jobs.markDone(jobId, results);
    log.info("scrape done", { jobId, claims: processed, records: results.length });
  } catch (err) {
    log.error("scrape failed", { jobId, err: String(err) });
    jobs.markError(jobId, String(err));
  } finally {
    await context.close();
    await browser.close();
  }
}
