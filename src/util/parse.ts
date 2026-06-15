/** Parse an Indian-rupee-formatted amount string to a number, or null. */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  // Strip specific currency tokens (₹, Rs., Rs, INR) and thousands separators.
  // Note: strip the literal tokens, NOT a generic "." — a generic dot strip
  // would turn a bare ".50" into "50" (100x too large).
  const cleaned = raw
    .replace(/₹/g, "")
    .replace(/\bRs\.?/gi, "")
    .replace(/\bINR\b/gi, "")
    .replace(/,/g, "") // remove thousands separators
    .trim();
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function claimKey(runId: string, employeeCode: string): string {
  return `${runId}::${employeeCode}`;
}

export function expenseHeadKey(
  claimId: string,
  expenseHead: string,
  billNumber: string | null
): string {
  return `${claimId}::${expenseHead}::${billNumber ?? ""}`;
}

export function attachmentKey(expenseHeadId: string, filename: string): string {
  return `${expenseHeadId}::${filename}`;
}

/** Make a single path segment safe (no slashes/spaces collapsing). Keeps the filename's dots. */
export function slugSegment(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Storage object path: {runId}/{employeeCode}/{expenseHeadSlug}/{filename} */
export function storagePath(
  runId: string,
  employeeCode: string,
  expenseHead: string,
  filename: string
): string {
  return `${slugSegment(runId)}/${slugSegment(employeeCode)}/${slugSegment(expenseHead)}/${filename}`;
}
