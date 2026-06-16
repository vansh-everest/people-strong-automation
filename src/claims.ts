import type { Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { ClaimRecord } from "./types.js";
import { parseAmount } from "./util/parse.js";
import { waitForMarker } from "./navigation.js";
import { log } from "./logger.js";

/** Raw structured data scraped from a rendered claim-detail panel. */
interface DetailDump {
  empCode: string | null;
  empName: string | null;
  totalClaimed: string | null;
  rows: Record<string, string | null>[];
}

/**
 * Read the rendered claim-detail panel (the right panel that PrimeFaces loads when a
 * task row is clicked) and return one ClaimRecord per expense-head row in the
 * "Claim Detail" table. Employee + total-claimed are claim-level and copied onto each.
 *
 * The detail uses a `<dl><dt><label>…</dt><dd>value</dd></dl>` field layout and stable
 * value ids (hrReimbursementclaim:empCodeVal / empNameVal). Both the claim-detail table
 * and the queue table use `td > div.m-data-header` to label each cell, so we read each
 * cell by its header rather than by fragile column position.
 */
export async function extractClaimRecords(taskTab: Page): Promise<ClaimRecord[]> {
  const data: DetailDump = await taskTab.evaluate(() => {
    const clean = (el: Element | null) =>
      el ? (el.textContent || "").replace(/\s+/g, " ").trim() || null : null;
    const byId = (id: string) => document.querySelector(`[id="${id}"]`);

    const dlValue = (labelRe: RegExp): string | null => {
      for (const dt of Array.from(document.querySelectorAll("dt"))) {
        const label = dt.querySelector("label");
        if (label && labelRe.test((label.textContent || "").trim())) {
          const dd = dt.nextElementSibling;
          if (dd && dd.tagName === "DD") return clean(dd);
        }
      }
      return null;
    };

    const empCode = clean(byId("hrReimbursementclaim:empCodeVal"));
    const empName = clean(byId("hrReimbursementclaim:empNameVal"));
    const totalClaimed = dlValue(/Total Claimed Amount/i);

    // Find the "Claim Detail" table (headers include Expense Head + Bill Number).
    const rows: Record<string, string | null>[] = [];
    for (const tbl of Array.from(document.querySelectorAll("table"))) {
      const t = tbl.innerText || "";
      if (/Expense Head/i.test(t) && /Bill Number/i.test(t)) {
        for (const tr of Array.from(tbl.querySelectorAll("tbody tr"))) {
          const rec: Record<string, string | null> = {};
          for (const td of Array.from(tr.querySelectorAll("td"))) {
            const header = td.querySelector(".m-data-header");
            const key = header ? (header.textContent || "").replace(/\s+/g, " ").trim() : null;
            if (!key) continue;
            const headerText = header ? header.textContent || "" : "";
            const value = (td.textContent || "")
              .replace(headerText, "")
              .replace(/\s+/g, " ")
              .trim();
            rec[key] = value || null;
          }
          if (Object.keys(rec).length) rows.push(rec);
        }
        break;
      }
    }

    return { empCode, empName, totalClaimed, rows };
  });

  const totalClaimed = parseAmount(data.totalClaimed);

  // Attachments are downloaded separately (captureAttachments) and merged by the caller,
  // because that needs Playwright actions (click → download), not a DOM read.
  const base = {
    employee_code: data.empCode,
    employee_name: data.empName,
    total_claimed_amount: totalClaimed,
    attachment_filename: null as string | null,
    attachment_url: null as string | null,
  };

  const records: ClaimRecord[] = data.rows.map((r) => ({
    ...base,
    expense_head: r["Expense Head"] ?? null,
    bill_period: r["Bill Period"] ?? null,
    bill_number: r["Bill Number"] ?? null,
    start_date: r["Start Date"] ?? null,
    end_date: r["End Date"] ?? null,
    bill_date: r["Bill Date"] ?? null,
    payment_mode: r["Payment Mode"] ?? null,
    vendor: r["Vendor"] ?? null,
    eligible_amount: parseAmount(r["Eligible Amount"] ?? null),
    approval_amount: parseAmount(r["Approved Amount"] ?? r["Approval Amount"] ?? null),
    claim_amount: parseAmount(r["Claim Amount"] ?? null),
    employee_comment: r["Employee Comment"] ?? null,
    approver_comments: r["Approver Comments"] ?? r["Approver Comment"] ?? null,
  }));

  // A claim with no expense-head rows still yields one record with claim-level info.
  if (records.length === 0) {
    records.push({
      ...base,
      expense_head: null, bill_period: null, bill_number: null,
      start_date: null, end_date: null, bill_date: null,
      payment_mode: null, vendor: null,
      eligible_amount: null, approval_amount: null, claim_amount: null,
      employee_comment: null, approver_comments: null,
    });
  }

  log.info("claim extracted", { employeeCode: data.empCode, heads: records.length });
  return records;
}

/**
 * Open the task row at `index` on the current queue page and wait for its detail panel
 * to render (PrimeFaces loads it into the right panel via AJAX).
 */
export async function openClaim(taskTab: Page, cfg: AppConfig, index: number): Promise<void> {
  const link = taskTab.locator(cfg.selectors.TASK_LINK).nth(index);
  await link.waitFor({ state: "visible", timeout: 20000 });
  await link.scrollIntoViewIfNeeded().catch(() => {});
  // Let any PrimeFaces AJAX overlay/spinner clear so the click actually lands.
  await taskTab
    .locator(".ui-blockui, .ui-blockui-content, #ajaxStatusPanel")
    .first()
    .waitFor({ state: "hidden", timeout: 5000 })
    .catch(() => {});
  await link.click({ timeout: 15000 });
  await taskTab.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await waitForMarker(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);
}
