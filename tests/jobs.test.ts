import { describe, it, expect } from "vitest";
import { JobStore } from "../src/jobs.js";
import type { ClaimRecord } from "../src/types.js";

const rec = (code: string): ClaimRecord =>
  ({ employee_code: code } as ClaimRecord);

describe("JobStore (in-memory)", () => {
  it("creates a running job with a uuid", () => {
    const s = new JobStore();
    const j = s.create();
    expect(j.status).toBe("running");
    expect(j.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.get(j.id)?.status).toBe("running");
  });

  it("tracks progress and completes with results", () => {
    const s = new JobStore();
    const j = s.create();
    s.setProgress(j.id, 2, 10);
    expect(s.get(j.id)?.processed).toBe(2);
    expect(s.get(j.id)?.total).toBe(10);
    s.markDone(j.id, [rec("E1"), rec("E2")]);
    const done = s.get(j.id)!;
    expect(done.status).toBe("done");
    expect(done.results?.length).toBe(2);
    expect(done.total).toBe(2);
  });

  it("markError sets error status + message", () => {
    const s = new JobStore();
    const j = s.create();
    s.markError(j.id, "boom");
    expect(s.get(j.id)?.status).toBe("error");
    expect(s.get(j.id)?.error).toBe("boom");
  });

  it("returns null for unknown job", () => {
    expect(new JobStore().get("nope")).toBeNull();
  });

  it("single-job guard blocks a second concurrent acquire", () => {
    const s = new JobStore();
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
    s.release();
    expect(s.tryAcquire()).toBe(true);
  });
});
