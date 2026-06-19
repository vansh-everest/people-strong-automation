import { randomUUID } from "node:crypto";
import type { ClaimRecord, JobRecord } from "./types.js";

/**
 * In-memory job store. The worker scrapes and returns results; the Everest platform
 * polls GET /job/:id and ingests them. A sync completes within one worker uptime, so
 * jobs live in memory (no DB). A single-job guard avoids concurrent Chromium sessions.
 */
export class JobStore {
  private jobs = new Map<string, JobRecord>();
  private active = false;

  /** Returns false if a job is already running. */
  tryAcquire(): boolean {
    if (this.active) return false;
    this.active = true;
    return true;
  }

  release(): void {
    this.active = false;
  }

  create(): JobRecord {
    const job: JobRecord = {
      id: randomUUID(),
      status: "running",
      processed: 0,
      total: 0,
      results: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  setProgress(id: string, processed: number, total: number): void {
    const j = this.jobs.get(id);
    if (j) {
      j.processed = processed;
      j.total = total;
    }
  }

  /** Publish partial results while still running, so GET /job streams rows as they arrive. */
  setResults(id: string, results: ClaimRecord[]): void {
    const j = this.jobs.get(id);
    if (j && j.status === "running") j.results = [...results];
  }

  markDone(id: string, results: ClaimRecord[]): void {
    const j = this.jobs.get(id);
    if (j) {
      j.status = "done";
      j.results = results;
      j.processed = results.length;
      j.total = results.length;
    }
  }

  markError(id: string, error: string): void {
    const j = this.jobs.get(id);
    if (j) {
      j.status = "error";
      j.error = error;
    }
  }

  get(id: string): JobRecord | null {
    return this.jobs.get(id) ?? null;
  }
}
