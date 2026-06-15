import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { buildApp } from "../src/server.js";
import type { JobRecord } from "../src/types.js";

function fakeJobStore() {
  const jobs = new Map<string, JobRecord>();
  let seq = 0;
  return {
    store: {
      tryAcquire: vi.fn(() => true),
      release: vi.fn(),
      async create(input: any) {
        const id = "job-" + ++seq;
        const rec: JobRecord = {
          id, status: "queued",
          progress: { processed: 0, total: 0, currentEmployee: null },
          results: null, error: null,
          stageFilter: input.stageFilter, limit: input.limit,
        };
        jobs.set(id, rec);
        return rec;
      },
      async get(id: string) { return jobs.get(id) ?? null; },
    } as any,
    jobs,
  };
}

describe("server", () => {
  const SECRET = "topsecret";
  let runner: ReturnType<typeof vi.fn>;
  let jobStore: ReturnType<typeof fakeJobStore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    runner = vi.fn().mockResolvedValue(undefined);
    jobStore = fakeJobStore();
    app = buildApp({ workerSecret: SECRET, jobs: jobStore.store, runJob: runner, defaultStageFilter: "Finance Manager Approval" });
  });

  it("GET /health needs no auth", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("rejects missing/wrong secret", async () => {
    expect((await request(app).post("/sync-claims")).status).toBe(401);
    expect((await request(app).post("/sync-claims").set("X-Worker-Secret", "nope")).status).toBe(401);
  });

  it("POST /sync-claims returns jobId and invokes the runner", async () => {
    const res = await request(app)
      .post("/sync-claims")
      .set("X-Worker-Secret", SECRET)
      .send({ limit: 3 });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toMatch(/^job-/);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("409 when a job is already running", async () => {
    jobStore.store.tryAcquire = vi.fn(() => false);
    const res = await request(app).post("/sync-claims").set("X-Worker-Secret", SECRET).send({});
    expect(res.status).toBe(409);
  });

  it("GET /job/:id returns status or 404", async () => {
    const created = await request(app).post("/sync-claims").set("X-Worker-Secret", SECRET).send({});
    const id = created.body.jobId;
    const ok = await request(app).get(`/job/${id}`).set("X-Worker-Secret", SECRET);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBeDefined();
    const missing = await request(app).get("/job/nope").set("X-Worker-Secret", SECRET);
    expect(missing.status).toBe(404);
  });
});
