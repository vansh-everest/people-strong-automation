import type { Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import type { Claim, ExpenseHead } from "./types.js";
import { parseAmount } from "./util/parse.js";
import { waitForMarker } from "./navigation.js";
import { captureAttachments } from "./attachments.js";
import { log } from "./logger.js";

/** A scraped claim plus the downloaded attachment bytes, keyed by `${expenseHead}::${filename}`. */
export interface ExtractedClaim {
  claim: Claim;
  bytes: Map<string, Uint8Array>;
}

/** Build the bytes-map key for an attachment within a given expense head. */
export function attachmentBytesKey(expenseHead: string, filename: string): string {
  return `${expenseHead}::${filename}`;
}

/**
 * Read the value associated with a label inside the detail panel.
 * Strategy: find the element containing the label text, then read the text of the
 * following sibling / adjacent value cell. Falls back to null if not found.
 */
export async function fieldValue(scope: Page | Locator, label: string): Promise<string | null> {
  const labelEl = scope
    .locator(`xpath=.//*[contains(normalize-space(.), ${xpathLiteral(label)})]`)
    .first();
  if ((await labelEl.count()) === 0) return null;
  const value = labelEl
    .locator(
      "xpath=following-sibling::*[1] | ../following-sibling::*[1] | ../td[2] | ../../td[2]"
    )
    .first();
  const txt = await value.innerText().catch(() => null);
  return txt ? txt.trim() || null : null;
}

/** Escape a string for use as an XPath string literal. */
export function xpathLiteral(s: string): string {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return "concat('" + s.split("'").join("',\"'\",'") + "')";
}

/** Capture employee code + name from a task row's text before clicking it. */
export function parseRowEmployee(rowText: string): { employeeName: string; employeeCode: string } {
  // Rows commonly read like "Asha Rao (E12345) - Finance Manager Approval".
  const codeMatch = rowText.match(/\(([A-Za-z0-9\-]+)\)/);
  const employeeCode = codeMatch ? codeMatch[1] : rowText.trim();
  const employeeName = codeMatch ? rowText.slice(0, codeMatch.index).trim() : rowText.trim();
  return { employeeName, employeeCode };
}

/**
 * Open one task row and extract the claim header + all expense heads, capturing each
 * head's attachment bytes WHILE that head's panel is the rendered one.
 */
export async function extractClaim(
  taskTab: Page,
  row: Locator,
  cfg: AppConfig
): Promise<ExtractedClaim> {
  const rowText = (await row.innerText().catch(() => "")) ?? "";
  const { employeeName, employeeCode } = parseRowEmployee(rowText);

  await row.click();
  // PrimeFaces partial update — wait for the Total Claimed Amount label to render.
  await waitForMarker(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);

  const totalRaw = await fieldValue(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);
  const status = await fieldValue(taskTab, "Status");

  const { heads, bytes } = await extractExpenseHeads(taskTab, cfg);

  const claim: Claim = {
    employeeCode,
    employeeName,
    totalClaimedAmount: parseAmount(totalRaw),
    status,
    expenseHeads: heads,
  };

  log.info("claim extracted", { employeeCode, heads: heads.length });
  return { claim, bytes };
}

/**
 * Loop expense-head links: for each, render its panel, extract the 14 fields, and capture
 * THAT head's attachments before moving to the next head. Returns the heads plus a bytes-map
 * keyed by `${expenseHead}::${filename}` so callers can persist each file under the right head.
 */
export async function extractExpenseHeads(
  taskTab: Page,
  cfg: AppConfig
): Promise<{ heads: ExpenseHead[]; bytes: Map<string, Uint8Array> }> {
  const links = taskTab.locator(cfg.selectors.EXPENSE_HEAD_LINK);
  const count = await links.count();
  const heads: ExpenseHead[] = [];
  const bytes = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const headName = (await link.innerText().catch(() => `head-${i}`)).trim();
    await link.click();
    // Wait for the accounting/claim section to render.
    await waitForMarker(taskTab, "Accounting Information").catch(() =>
      waitForMarker(taskTab, "Reimbursement Claim")
    );

    // Capture this head's attachments while its panel is the rendered one.
    const dls = await captureAttachments(taskTab, cfg);
    for (const d of dls) bytes.set(attachmentBytesKey(headName, d.meta.filename), d.bytes);

    heads.push({
      expenseHead: headName,
      expenseCategory: await fieldValue(taskTab, "Expense Category"),
      billPeriod: await fieldValue(taskTab, "Bill Period"),
      billNumber: await fieldValue(taskTab, "Bill Number"),
      startDate: await fieldValue(taskTab, "Start Date"),
      endDate: await fieldValue(taskTab, "End Date"),
      billDate: await fieldValue(taskTab, "Bill Date"),
      paymentMode: await fieldValue(taskTab, "Payment Mode"),
      vendor: await fieldValue(taskTab, "Vendor"),
      eligibleAmount: parseAmount(await fieldValue(taskTab, "Eligible Amount")),
      approvalAmount: parseAmount(await fieldValue(taskTab, "Approval Amount")),
      claimAmount: parseAmount(await fieldValue(taskTab, "Claim Amount")),
      employeeComment: await fieldValue(taskTab, "Employee Comment"),
      approverComments: await fieldValue(taskTab, "Approver Comments"),
      attachments: dls.map((d) => d.meta),
    });
  }
  return { heads, bytes };
}
