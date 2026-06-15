import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import { log } from "./logger.js";

function statePath(cfg: AppConfig): string {
  return join(cfg.storageDir, "state.json");
}

/** Create a context, reusing persisted storageState if present. */
export async function createContext(browser: Browser, cfg: AppConfig): Promise<BrowserContext> {
  const sp = statePath(cfg);
  if (existsSync(sp)) {
    log.info("reusing persisted session", { sp });
    return browser.newContext({ storageState: sp, acceptDownloads: true });
  }
  return browser.newContext({ acceptDownloads: true });
}

/** True if the logged-in marker is visible (i.e. session still valid). */
export async function isLoggedIn(page: Page, cfg: AppConfig): Promise<boolean> {
  try {
    await page.waitForSelector(cfg.selectors.LOGGED_IN_MARKER, { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
}

/** Perform username/password login and persist storageState. */
export async function login(context: BrowserContext, page: Page, cfg: AppConfig): Promise<void> {
  const { selectors, secrets } = cfg;
  log.info("logging in", { url: selectors.LOGIN_URL });
  await page.goto(selectors.LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.fill(selectors.USERNAME_SELECTOR, secrets.PEOPLESTRONG_USER);
  await page.fill(selectors.PASSWORD_SELECTOR, secrets.PEOPLESTRONG_PASS);
  await page.click(selectors.LOGIN_BUTTON_SELECTOR);
  await page.waitForSelector(selectors.LOGGED_IN_MARKER, { timeout: 30000 });

  const sp = statePath(cfg);
  await mkdir(dirname(sp), { recursive: true });
  await context.storageState({ path: sp });
  log.info("login complete, session persisted", { sp });
}

/** Ensure we are on the dashboard and logged in; re-login if the session expired. */
export async function ensureSession(
  context: BrowserContext,
  page: Page,
  cfg: AppConfig
): Promise<void> {
  await page.goto(cfg.selectors.BASE_URL, { waitUntil: "domcontentloaded" });
  if (await isLoggedIn(page, cfg)) return;
  await login(context, page, cfg);
}
