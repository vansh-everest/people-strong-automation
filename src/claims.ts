import type { Page, Locator } from "playwright";
import type { AppConfig } from "./config.js";
import type { Claim, ExpenseHead } from "./types.js";
import { parseAmount } from "./util/parse.js";
import { waitForMarker } from "./navigation.js";
import { log } from "./logger.js";

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

/** Open one task row and extract the claim header + all expense heads (without attachments). */
export async function extractClaim(
  taskTab: Page,
  row: Locator,
  cfg: AppConfig
): Promise<Claim> {
  const rowText = (await row.innerText().catch(() => "")) ?? "";
  const { employeeName, employeeCode } = parseRowEmployee(rowText);

  await row.click();
  // PrimeFaces partial update — wait for the Total Claimed Amount label to render.
  await waitForMarker(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);

  const totalRaw = await fieldValue(taskTab, cfg.selectors.TOTAL_CLAIMED_LABEL);
  const status = await fieldValue(taskTab, "Status");

  const claim: Claim = {
    employeeCode,
    employeeName,
    totalClaimedAmount: parseAmount(totalRaw),
    status,
    expenseHeads: [],
  };

  claim.expenseHeads = await extractExpenseHeads(taskTab, cfg);
  log.info("claim extracted", { employeeCode, heads: claim.expenseHeads.length });
  return claim;
}

/** Loop expense-head links and extract the 14 fields for each. */
export async function extractExpenseHeads(taskTab: Page, cfg: AppConfig): Promise<ExpenseHead[]> {
  const links = taskTab.locator(cfg.selectors.EXPENSE_HEAD_LINK);
  const count = await links.count();
  const heads: ExpenseHead[] = [];

  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    const headName = (await link.innerText().catch(() => `head-${i}`)).trim();
    await link.click();
    // Wait for the accounting/claim section to render.
    await waitForMarker(taskTab, "Accounting Information").catch(() =>
      waitForMarker(taskTab, "Reimbursement Claim")
    );

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
      attachments: [],
    });
  }
  return heads;
}
