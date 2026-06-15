import type { SupabaseClient } from "@supabase/supabase-js";
import type { Claim, JobRecord, Progress } from "./types.js";

interface DbRow {
  id: string;
  status: JobRecord["status"];
  progress: Progress;
  results: Claim[] | null;
  error: string | null;
  stage_filter: string | null;
  limit: number | null;
}

function toRecord(row: DbRow): JobRecord {
  return {
    id: row.id,
    status: row.status,
    progress: row.progress,
    results: row.results,
    error: row.error,
    stageFilter: row.stage_filter,
    limit: row.limit,
  };
}

export class JobStore {
  private active = false;

  constructor(private client: SupabaseClient) {}

  /** In-process single-job guard. Returns false if a job is already running. */
  tryAcquire(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  release(): void {
    this.active = false;
  }

  async create(input: { stageFilter: string | null; limit: number | null }): Promise<JobRecord> {
    const { data, error } = await this.client
      .from("sync_jobs")
      .insert({
        status: "queued",
        progress: { processed: 0, total: 0, currentEmployee: null },
        stage_filter: input.stageFilter,
        limit: input.limit,
      })
      .select()
      .single();
    if (error) throw error;
    return toRecord(data as DbRow);
  }

  private async patch(id: string, patch: Partial<DbRow>): Promise<void> {
    const { error } = await this.client
      .from("sync_jobs")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) throw error;
  }

  markRunning(id: string) {
    return this.patch(id, { status: "running" });
  }

  updateProgress(id: string, progress: Progress) {
    return this.patch(id, { progress });
  }

  markDone(id: string, results: Claim[]) {
    return this.patch(id, { status: "done", results });
  }

  markFailed(id: string, error: string) {
    return this.patch(id, { status: "failed", error });
  }

  async get(id: string): Promise<JobRecord | null> {
    const { data, error } = await this.client
      .from("sync_jobs")
      .select("*")
      .eq("id", id)
      .single();
    if (error || !data) return null;
    return toRecord(data as DbRow);
  }
}
