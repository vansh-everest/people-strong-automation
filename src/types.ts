/**
 * One reimbursement expense-head record, exactly as the Everest platform's worker
 * contract expects (lib/reimbursement/types.ts → ClaimRecord). One claim with N
 * expense heads produces N records (each carrying the claim-level fields too).
 * snake_case is intentional — the platform ingests these keys verbatim.
 */
export interface ClaimRecord {
  employee_code: string | null;
  employee_name: string | null;
  total_claimed_amount: number | string | null;
  expense_head: string | null;
  bill_period: string | null;
  bill_number: string | null;
  start_date: string | null;
  end_date: string | null;
  bill_date: string | null;
  payment_mode: string | null;
  vendor: string | null;
  eligible_amount: number | string | null;
  approval_amount: number | string | null;
  claim_amount: number | string | null;
  employee_comment: string | null;
  approver_comments: string | null;
  attachment_filename: string | null;
  attachment_url: string | null;
}

/** Job lifecycle — matches the platform's RunStatus (running | done | error). */
export type JobStatus = "running" | "done" | "error";

export interface JobRecord {
  id: string;
  status: JobStatus;
  processed: number;
  total: number;
  results: ClaimRecord[] | null;
  error: string | null;
}
