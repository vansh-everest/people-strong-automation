import { describe, it, expect, vi } from "vitest";
import { JobStore } from "../src/jobs.js";

function makeMockClient() {
  const store = new Map<string, any>();
  let idSeq = 0;
  const client: any = {
    from(table: string) {
      if (table !== "sync_jobs") throw new Error("unexpected table " + table);
      return {
        insert(row: any) {
          return {
            select() {
              return {
                async single() {
                  const id = "job-" + ++idSeq;
                  const rec = { id, ...row };
                  store.set(id, rec);
                  return { data: rec, error: null };
                },
              };
            },
          };
        },
        update(patch: any) {
          return {
            async eq(_col: string, id: string) {
              const rec = store.get(id);
              if (rec) store.set(id, { ...rec, ...patch });
              return { data: null, error: null };
            },
          };
        },
        select(_cols: string) {
          return {
            eq(_col: string, id: string) {
              return {
                async single() {
                  return { data: store.get(id) ?? null, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, store };
}

describe("JobStore", () => {
  it("creates a queued job", async () => {
    const { client } = makeMockClient();
    const store = new JobStore(client);
    const job = await store.create({ stageFilter: "Finance Manager Approval", limit: 5 });
    expect(job.status).toBe("queued");
    expect(job.id).toMatch(/^job-/);
    expect(job.stageFilter).toBe("Finance Manager Approval");
  });

  it("transitions status and progress", async () => {
    const { client } = makeMockClient();
    const store = new JobStore(client);
    const job = await store.create({ stageFilter: null, limit: null });
    await store.markRunning(job.id);
    await store.updateProgress(job.id, { processed: 2, total: 10, currentEmployee: "E1" });
    const fetched = await store.get(job.id);
    expect(fetched!.status).toBe("running");
    expect(fetched!.progress.processed).toBe(2);
  });

  it("blocks a second concurrent run while one is active", async () => {
    const { client } = makeMockClient();
    const store = new JobStore(client);
    expect(store.tryAcquire()).toBe(true);
    expect(store.tryAcquire()).toBe(false);
    store.release();
    expect(store.tryAcquire()).toBe(true);
  });
});
