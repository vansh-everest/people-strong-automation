import { describe, it, expect } from "vitest";
import { ClaimStore } from "../src/storage.js";
import type { Claim } from "../src/types.js";

function makeRecordingClient() {
  const calls: any[] = [];
  const uploads: any[] = [];
  let idSeq = 0;
  const client: any = {
    from(table: string) {
      return {
        upsert(rows: any, opts: any) {
          calls.push({ table, rows, opts });
          return {
            select() {
              return {
                async single() {
                  const row = Array.isArray(rows) ? rows[0] : rows;
                  return { data: { id: `${table}-${++idSeq}`, ...row }, error: null };
                },
              };
            },
          };
        },
      };
    },
    storage: {
      from(bucket: string) {
        return {
          async upload(path: string, _bytes: Uint8Array, opts: any) {
            uploads.push({ bucket, path, opts });
            return { data: { path }, error: null };
          },
        };
      },
    },
  };
  return { client, calls, uploads };
}

const claim: Claim = {
  employeeCode: "E1",
  employeeName: "Asha",
  totalClaimedAmount: 1200,
  status: "Pending for Finance Manager Approval",
  expenseHeads: [
    {
      expenseHead: "Miscellaneous",
      expenseCategory: "Misc",
      billPeriod: "Jun 2026",
      billNumber: "B-9",
      startDate: null,
      endDate: null,
      billDate: "2026-06-01",
      paymentMode: "Cash",
      vendor: "ACME",
      eligibleAmount: 1200,
      approvalAmount: null,
      claimAmount: 1200,
      employeeComment: "ok",
      approverComments: null,
      attachments: [
        {
          filename: "petrol (1).pdf",
          storagePath: "",
          sourceResponseUrl: "https://x/y",
          ocrStatus: "pending",
        },
      ],
    },
  ],
};

describe("ClaimStore.persistClaim", () => {
  it("upserts claim, expense heads, attachments with conflict keys", async () => {
    const { client, calls } = makeRecordingClient();
    const store = new ClaimStore(client, "peoplestrong-claims");
    await store.persistClaim("job-1", claim, async () => new Uint8Array([1, 2, 3]));

    const claimCall = calls.find((c) => c.table === "claims");
    expect(claimCall.opts.onConflict).toBe("run_id,employee_code");
    expect(claimCall.rows.run_id).toBe("job-1");
    expect(claimCall.rows.total_claimed_amount).toBe(1200);

    const ehCall = calls.find((c) => c.table === "expense_heads");
    expect(ehCall.opts.onConflict).toBe("claim_id,expense_head,bill_number");
    expect(ehCall.rows.bill_number).toBe("B-9");

    const attCall = calls.find((c) => c.table === "attachments");
    expect(attCall.opts.onConflict).toBe("expense_head_id,filename");
  });

  it("uploads each attachment's bytes to the bucket and records the path", async () => {
    const { client, uploads, calls } = makeRecordingClient();
    const store = new ClaimStore(client, "peoplestrong-claims");
    await store.persistClaim("job-1", claim, async () => new Uint8Array([9]));
    expect(uploads).toHaveLength(1);
    expect(uploads[0].path).toBe("job-1/E1/Miscellaneous/petrol (1).pdf");
    const attCall = calls.find((c) => c.table === "attachments");
    expect(attCall.rows.storage_path).toBe("job-1/E1/Miscellaneous/petrol (1).pdf");
  });
});
