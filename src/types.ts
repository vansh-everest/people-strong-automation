export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Progress {
  processed: number;
  total: number;
  currentEmployee: string | null;
}

export interface Attachment {
  filename: string;
  storagePath: string;
  sourceResponseUrl: string | null;
  ocrStatus: "pending";
}

export interface ExpenseHead {
  expenseHead: string;
  expenseCategory: string | null;
  billPeriod: string | null;
  billNumber: string | null;
  startDate: string | null;
  endDate: string | null;
  billDate: string | null;
  paymentMode: string | null;
  vendor: string | null;
  eligibleAmount: number | null;
  approvalAmount: number | null;
  claimAmount: number | null;
  employeeComment: string | null;
  approverComments: string | null;
  attachments: Attachment[];
}

export interface Claim {
  employeeCode: string;
  employeeName: string;
  totalClaimedAmount: number | null;
  status: string | null;
  expenseHeads: ExpenseHead[];
  error?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: Progress;
  results: Claim[] | null;
  error: string | null;
  stageFilter: string | null;
  limit: number | null;
}
