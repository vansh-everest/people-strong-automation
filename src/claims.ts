import type { Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { ClaimRecord } from "./types.js";
import { parseAmount } from "./util/parse.js";
import { waitForMarker } from "./navigation.js";
import { captureAttachments } from "./attachments.js";
import { log } from "./logger.js";

/** Fields read from an expense-head modal (only place they appear). */
interface ModalFields {
  vendor: string | null;
  startDate: string | null;
  endDate: string | null;
  billDate: string | null;
  billNumber: string | null;
  paymentMode: string | null;
}

/** Read the open expense-head modal's input/select values (ids carry a varying counter). */
async function readModalFields(taskTab: Page): Promise<ModalFields> {
  return taskTab.evaluate(() => {
    const v = (sel: string) => {
      const e = document.querySelector(sel) as HTMLInputElement | null;
      return e ? (e.value || "").trim() || null : null;
    };
    const menu = (sel: string) => {
      const e = document.querySelector(sel);
      return e ? (e.textContent || "").replace(/\s+/g, " ").trim() || null : null;
    };
    return {
      vendor: v('[id*="Vendor"]'),
      startDate: v('[id*="StartDate"][id$="_input"]'),
      endDate: v('[id*="EndDate"][id$="_input"]'),
      billDate: v('[id*="BillDate"][id$="_input"]'),
      billNumber: v('[id*="BillNumber"]'),
      paymentMode: menu('[id*="PaymentMode"] .ui-selectonemenu-label') || v('[id*="PaymentMode"][id$="_input"]'),
    };
  });
}

/** Close the expense-head modal via Cancel / the dialog close icon — NEVER "Update". */
async function closeModal(taskTab: Page): Promise<void> {
  const cancel = taskTab.getByRole("button", { name: /^cancel$/i }).first();
  if (await cancel.isVisible().catch(() => false)) {
    await cancel.click({ timeout: 5000 }).catch(() => {});
  } else {
    await taskTab.locator(".ui-dialog-titlebar-close").first().click({ timeout: 5000 }).catch(() => {});
  }
  await taskTab
    .locator('[id*="StartDate"][id$="_input"]')
    .first()
    .waitFor({ state: "hidden", timeout: 8000 })
    .catch(() => {});
}

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
export async function extractClaimRecords(taskTab: Page, cfg: AppConfig): Promise<ClaimRecord[]> {
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

  // Per expense head: open its modal to read the fields that ONLY appear there
  // (vendor, start/end date, payment mode) and to capture that head's attachment
  // (the attachmentsList datalist shows the open head's file). Never click "Update".
  const headLinks = taskTab.locator(cfg.selectors.EXPENSE_HEAD_LINK);
  const nHeads = await headLinks.count().catch(() => 0);
  for (let i = 0; i < nHeads && i < records.length; i++) {
    try {
      await headLinks.nth(i).click({ timeout: 12000 });
      await taskTab
        .locator('[id*="StartDate"][id$="_input"]')
        .first()
        .waitFor({ state: "visible", timeout: 12000 })
        .catch(() => {});
      const m = await readModalFields(taskTab);
      const rec = records[i];
      if (m.vendor) rec.vendor = m.vendor;
      if (m.startDate) rec.start_date = m.startDate;
      if (m.endDate) rec.end_date = m.endDate;
      if (m.paymentMode) rec.payment_mode = m.paymentMode;
      if (!rec.bill_number && m.billNumber) rec.bill_number = m.billNumber;
      if (!rec.bill_date && m.billDate) rec.bill_date = m.billDate;

      // This head's attachment(s) — the datalist reflects the open modal.
      const atts = await captureAttachments(taskTab, cfg);
      if (atts[0]) {
        rec.attachment_filename = atts[0].filename;
        rec.attachment_url = atts[0].dataUrl;
      }
    } catch (err) {
      log.warn("expense-head modal failed", { index: i, err: String(err) });
    } finally {
      await closeModal(taskTab).catch(() => {});
    }
  }

  log.info("claim extracted", {
    employeeCode: data.empCode,
    heads: records.length,
    withAttachment: records.filter((r) => r.attachment_url).length,
  });
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
