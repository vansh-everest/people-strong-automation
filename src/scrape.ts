import { chromium } from "playwright";
import type { AppConfig } from "./config.js";
import type { ClaimRecord } from "./types.js";
import { JobStore } from "./jobs.js";
import { createContext, ensureSession } from "./session.js";
import { openTaskTab, openQueue, rowCount, goBackToList, pageCount, gotoPage } from "./navigation.js";
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
    const pages = await pageCount(taskTab);
    jobs.setProgress(jobId, 0, limit ?? pending ?? 0);

    // Opening a claim replaces the list and BACK resets the paginator to page 1, so we
    // explicitly navigate to each claim's page (1-based) before opening it.
    let processed = 0; // claims processed (not records)
    let stop = false;
    for (let p = 1; p <= pages && !stop; p++) {
      for (let i = 0; !stop; i++) {
        if (limit && processed >= limit) {
          stop = true;
          break;
        }
        // Re-assert the page (a prior BACK resets to page 1) and read the LIVE row count,
        // so we never click a phantom index on a short last page.
        await gotoPage(taskTab, p);
        if (i >= (await rowCount(taskTab, cfg))) break; // page exhausted

        let opened = false;
        try {
          await withRetry(() => openClaim(taskTab, cfg, i), RETRY);
          opened = true;
          const recs = await extractClaimRecords(taskTab);
          results.push(...recs);
        } catch (err) {
          log.error("claim failed", { page: p, index: i, err: String(err) });
        }
        processed++;
        jobs.setProgress(jobId, processed, limit ?? pending ?? 0);

        // Only navigate back if a claim detail actually opened (a failed click leaves
        // us on the list already).
        if (opened) {
          try {
            await goBackToList(taskTab, cfg);
          } catch (err) {
            log.error("could not return to task list; stopping", { err: String(err) });
            stop = true;
          }
        }
      }
    }

    jobs.markDone(jobId, results);
    log.info("scrape done", { jobId, claims: processed, records: results.length, pages });
  } catch (err) {
    log.error("scrape failed", { jobId, err: String(err) });
    jobs.markError(jobId, String(err));
  } finally {
    await context.close();
    await browser.close();
  }
}
