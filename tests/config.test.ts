import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const yamlPath = "./config/peoplestrong.yml";

const fullEnv = {
  WORKER_SECRET: "s",
  PEOPLESTRONG_USER: "u",
  PEOPLESTRONG_PASS: "p",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_KEY: "k",
};

describe("loadConfig", () => {
  it("loads selectors from yaml and secrets from env", () => {
    const cfg = loadConfig(yamlPath, fullEnv);
    expect(cfg.selectors.TASK_LINK).toBe("a[id*=ApproveRejectButton]");
    expect(cfg.selectors.QUEUE_TITLE_TEXT).toBe("Reimbursement Claim Requests");
    expect(cfg.secrets.WORKER_SECRET).toBe("s");
    expect(cfg.stageFilter).toBe("Finance Manager Approval");
  });

  it("throws if a required secret is missing", () => {
    const { WORKER_SECRET, ...partial } = fullEnv;
    expect(() => loadConfig(yamlPath, partial)).toThrow(/WORKER_SECRET/);
  });
});
