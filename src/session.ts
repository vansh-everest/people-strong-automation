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

/**
 * True if we appear logged in. The site root redirects to the HTML login form
 * (altLogin.jsf) when logged out, and to the Flutter "oneweb" SPA when logged in,
 * so "logged in" == the login form is NOT present.
 */
export async function isLoggedIn(page: Page, cfg: AppConfig): Promise<boolean> {
  const onLoginForm = await page
    .locator(cfg.selectors.LOGIN_FORM_MARKER)
    .first()
    .isVisible()
    .catch(() => false);
  return !onLoginForm && !/altLogin|sessionTimeout/i.test(page.url());
}

/** Perform username/password login and persist storageState. */
export async function login(context: BrowserContext, page: Page, cfg: AppConfig): Promise<void> {
  const { selectors, secrets } = cfg;
  log.info("logging in", { url: selectors.LOGIN_URL });
  await page.goto(selectors.LOGIN_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(selectors.USERNAME_SELECTOR, { timeout: 30000 });
  await page.fill(selectors.USERNAME_SELECTOR, secrets.PEOPLESTRONG_USER);
  await page.fill(selectors.PASSWORD_SELECTOR, secrets.PEOPLESTRONG_PASS);
  await page.click(selectors.LOGIN_BUTTON_SELECTOR);
  // Login succeeds when we are redirected away from the login form.
  await page
    .waitForURL((u) => !/altLogin/i.test(u.toString()), { timeout: 45000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  if (!(await isLoggedIn(page, cfg))) {
    throw new Error("login failed — still on the login form after submit");
  }

  const sp = statePath(cfg);
  await mkdir(dirname(sp), { recursive: true });
  await context.storageState({ path: sp });
  log.info("login complete, session persisted", { sp, url: page.url() });
}

/** Ensure we are logged in; re-login if the session expired. */
export async function ensureSession(
  context: BrowserContext,
  page: Page,
  cfg: AppConfig
): Promise<void> {
  await page.goto(cfg.selectors.BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  if (await isLoggedIn(page, cfg)) {
    log.info("existing session valid", { url: page.url() });
    return;
  }
  await login(context, page, cfg);
}
