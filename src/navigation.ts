import type { BrowserContext, Page } from "playwright";
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

/**
 * Open the "Reimbursement Claim Requests" queue on the home.jsf dashboard.
 *
 * The Tasks badge is an Angular widget embedded in the JSF page; clicking it reveals
 * a dropdown listing task queues. Clicking "Reimbursement Claim Requests" renders the
 * PrimeFaces task table (rows = a[id*=ApproveRejectButton]). Returns the pending count
 * shown on the Tasks badge (or null).
 */
export async function openQueue(taskTab: Page, cfg: AppConfig): Promise<number | null> {
  // Read the pending count off the Tasks badge (".notification" next to the icon).
  let pending: number | null = null;
  try {
    const txt = await taskTab
      .locator(`xpath=//*[contains(@class,"mytasks_icon")]/preceding-sibling::*[contains(@class,"notification")][1]`)
      .first()
      .innerText();
    const n = Number(txt.replace(/[^0-9]/g, ""));
    pending = Number.isFinite(n) ? n : null;
  } catch {
    pending = null;
  }

  // Reveal the tasks dropdown.
  await taskTab
    .locator(cfg.selectors.TASKS_ICON)
    .first()
    .locator("xpath=ancestor-or-self::*[self::a or self::button or self::div][1]")
    .click({ timeout: 20000 });

  // Click the queue title in the dropdown.
  const title = taskTab.getByText(cfg.selectors.QUEUE_TITLE_TEXT, { exact: false }).first();
  await title.waitFor({ state: "visible", timeout: 20000 });
  await title.click();

  // Wait for the task table to render (or an empty queue).
  await taskTab
    .locator(cfg.selectors.TASK_LINK)
    .first()
    .waitFor({ state: "visible", timeout: 20000 })
    .catch(() => log.warn("no task rows after opening queue (empty?)"));

  log.info("queue opened", { pending, rows: await taskTab.locator(cfg.selectors.TASK_LINK).count() });
  return pending;
}

/** Number of task rows on the current page. */
export async function rowCount(taskTab: Page, cfg: AppConfig): Promise<number> {
  return taskTab.locator(cfg.selectors.TASK_LINK).count();
}

/**
 * Return from a claim-detail view to the task list. Opening a claim replaces the list,
 * so this clicks the detail's BACK button and waits for the task rows to re-render.
 */
export async function goBackToList(taskTab: Page, cfg: AppConfig): Promise<void> {
  const back = taskTab.locator(cfg.selectors.BACK_BUTTON).first();
  await back.waitFor({ state: "visible", timeout: 15000 });
  await back.click();
  await taskTab.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await taskTab
    .locator(cfg.selectors.TASK_LINK)
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
}

/**
 * Advance to the next page of the PrimeFaces paginator if one exists and is enabled.
 * Returns true if it advanced, false if already on the last page.
 */
export async function gotoNextPage(taskTab: Page): Promise<boolean> {
  const next = taskTab.locator("a.ui-paginator-next").first();
  if ((await next.count()) === 0) return false;
  const cls = (await next.getAttribute("class")) ?? "";
  if (/ui-state-disabled/.test(cls)) return false;
  await next.click();
  // PrimeFaces re-renders the table; brief settle on the datatable.
  await taskTab.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await taskTab.locator('a[id*="ApproveRejectButton"]').first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
  return true;
}
