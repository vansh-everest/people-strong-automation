import type { SupabaseClient } from "@supabase/supabase-js";
import type { Claim, ExpenseHead, Attachment } from "./types.js";
import { storagePath } from "./util/parse.js";

/**
 * Returns raw bytes for an attachment (download already performed by the scraper).
 * Receives the owning expense head so callers can disambiguate identical filenames
 * across different heads.
 */
export type BytesFor = (att: Attachment, eh: ExpenseHead) => Promise<Uint8Array>;

export class ClaimStore {
  constructor(private client: SupabaseClient, private bucket: string) {}

  async persistClaim(runId: string, claim: Claim, bytesFor: BytesFor): Promise<void> {
    const { data: claimRow, error: claimErr } = await this.client
      .from("claims")
      .upsert(
        {
          run_id: runId,
          employee_code: claim.employeeCode,
          employee_name: claim.employeeName,
          total_claimed_amount: claim.totalClaimedAmount,
          status: claim.status,
        },
        { onConflict: "run_id,employee_code" }
      )
      .select()
      .single();
    if (claimErr) throw claimErr;
    const claimId = (claimRow as { id: string }).id;

    for (const eh of claim.expenseHeads) {
      const ehId = await this.upsertExpenseHead(claimId, eh);
      for (const att of eh.attachments) {
        await this.upsertAttachment(runId, claim, eh, att, ehId, bytesFor);
      }
    }
  }

  private async upsertExpenseHead(claimId: string, eh: ExpenseHead): Promise<string> {
    const { data, error } = await this.client
      .from("expense_heads")
      .upsert(
        {
          claim_id: claimId,
          expense_head: eh.expenseHead,
          expense_category: eh.expenseCategory,
          bill_period: eh.billPeriod,
          bill_number: eh.billNumber,
          start_date: eh.startDate,
          end_date: eh.endDate,
          bill_date: eh.billDate,
          payment_mode: eh.paymentMode,
          vendor: eh.vendor,
          eligible_amount: eh.eligibleAmount,
          approval_amount: eh.approvalAmount,
          claim_amount: eh.claimAmount,
          employee_comment: eh.employeeComment,
          approver_comments: eh.approverComments,
        },
        { onConflict: "claim_id,expense_head,bill_number" }
      )
      .select()
      .single();
    if (error) throw error;
    return (data as { id: string }).id;
  }

  private async upsertAttachment(
    runId: string,
    claim: Claim,
    eh: ExpenseHead,
    att: Attachment,
    ehId: string,
    bytesFor: BytesFor
  ): Promise<void> {
    const path = storagePath(runId, claim.employeeCode, eh.expenseHead, att.filename);
    const bytes = await bytesFor(att, eh);
    const { error: upErr } = await this.client.storage
      .from(this.bucket)
      .upload(path, bytes, { upsert: true, contentType: "application/octet-stream" });
    if (upErr) throw upErr;

    const { error } = await this.client.from("attachments").upsert(
      {
        expense_head_id: ehId,
        filename: att.filename,
        storage_path: path,
        source_response_url: att.sourceResponseUrl,
        ocr_status: "pending",
      },
      { onConflict: "expense_head_id,filename" }
    );
    if (error) throw error;
  }

  /** Upload a failure screenshot under errors/{jobId}/. Returns the storage path. */
  async uploadErrorScreenshot(jobId: string, name: string, bytes: Uint8Array): Promise<string> {
    const path = `errors/${jobId}/${name}`;
    await this.client.storage
      .from(this.bucket)
      .upload(path, bytes, { upsert: true, contentType: "image/png" });
    return path;
  }
}
