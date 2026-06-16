import type { BrowserContext, Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

/**
 * Wait for a PrimeFaces AJAX partial update by waiting on a DOM marker (never a blind sleep).
 * `marker` may be a CSS selector or a text snippet; we wait for a matching element to be visible.
 */
export async function waitForMarker(page: Page, marker: string, timeout = 20000): Promise<void> {
  const looksLikeSelector = /[.#\[]/.test(marker);
  if (looksLikeSelector) {
    await page.waitForSelector(marker, { state: "visible", timeout });
  } else {
    await page.getByText(marker, { exact: false }).first().waitFor({ state: "visible", timeout });
  }
}

/**
 * Open the legacy PrimeFaces task app in a NEW TAB.
 *
 * After login the landing app is Flutter (not scrapable). The scrapable JSF task
 * dashboard is reached via the deeplink bridge (TASK_PAGE_URL), which establishes
 * the legacy JSF session and redirects to home.jsf?cid=<n>#/home. We open it in a
 * fresh tab in the same (authenticated) context. Throws if the JSF session is not
 * established (the bridge bounces to sessionTimeout/altLogin) so the caller can
 * re-login and retry.
 */
export async function openTaskTab(context: BrowserContext, cfg: AppConfig): Promise<Page> {
  const taskTab = await context.newPage();
  await taskTab.goto(cfg.selectors.TASK_PAGE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await taskTab.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  if (/sessionTimeout|altLogin/i.test(taskTab.url())) {
    await taskTab.close().catch(() => {});
    throw new Error(`JSF session not established (landed on ${taskTab.url()})`);
  }

  await taskTab.waitForSelector(cfg.selectors.TASK_PAGE_MARKER, { timeout: 30000 });
  log.info("task tab opened", { url: taskTab.url() });
  return taskTab;
}

/** Open the "Reimbursement Claim Requests" queue; return the pending count (or null). */
export async function openQueue(taskTab: Page, cfg: AppConfig): Promise<number | null> {
  const title = taskTab.getByText(cfg.selectors.QUEUE_TITLE_TEXT, { exact: false }).first();
  await title.waitFor({ state: "visible", timeout: 20000 });

  // pending-counts sits beside the title; read before clicking.
  let pending: number | null = null;
  try {
    const countText = await taskTab.locator("span.pending-counts").first().innerText();
    const n = Number(countText.replace(/[^0-9]/g, ""));
    pending = Number.isFinite(n) ? n : null;
  } catch {
    pending = null;
  }

  await title.click();
  // Wait for the task list to render (the first task link, or an empty-state).
  await taskTab
    .locator(cfg.selectors.TASK_LINK)
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => log.warn("no task links after opening queue (empty queue?)"));

  log.info("queue opened", { pending });
  return pending;
}

/** All task-row links matching the stage filter text. */
export async function taskRows(taskTab: Page, cfg: AppConfig): Promise<Locator[]> {
  const links = taskTab.locator(cfg.selectors.TASK_LINK);
  const count = await links.count();
  const out: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const text = (await link.innerText().catch(() => "")) ?? "";
    if (text.includes(cfg.stageFilter)) out.push(link);
  }
  return out;
}
