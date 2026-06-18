import express, { type Request, type Response, type NextFunction } from "express";
import { JobStore } from "./jobs.js";
import { loadConfig } from "./config.js";
import { runScrape } from "./scrape.js";
import { log } from "./logger.js";

export interface AppDeps {
  workerSecret: string;
  jobs: Pick<JobStore, "tryAcquire" | "release" | "create" | "get">;
  runJob: (jobId: string, opts: { stageFilter: string | null; limit: number | null }) => Promise<void>;
  defaultStageFilter: string;
}

export function buildApp(deps: AppDeps) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  const auth = (req: Request, res: Response, next: NextFunction) => {
    if (req.header("X-Worker-Secret") !== deps.workerSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }
    next();
  };

  app.post("/sync-claims", auth, (req, res) => {
    const stageFilter: string | null = req.body?.stageFilter ?? deps.defaultStageFilter;
    const limit: number | null = typeof req.body?.limit === "number" ? req.body.limit : null;

    if (!deps.jobs.tryAcquire()) {
      return res.status(409).json({ error: "a sync job is already running" });
    }

    const job = deps.jobs.create();

    // Fire-and-forget; always release the single-job guard when done.
    deps
      .runJob(job.id, { stageFilter, limit })
      .catch((err) => log.error("runJob crashed", { jobId: job.id, err: String(err) }))
      .finally(() => deps.jobs.release());

    return res.status(202).json({ jobId: job.id });
  });

  // Shape matches the platform's WorkerJob contract: { status, processed, total, results, error }.
  app.get("/job/:id", (req, res) => {
    if (req.header("X-Worker-Secret") !== deps.workerSecret) {
      return res.status(401).json({ error: "unauthorized" });
    }
    const job = deps.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    return res.json({
      status: job.status,
      processed: job.processed,
      total: job.total,
      results: job.results ?? undefined,
      error: job.error ?? undefined,
    });
  });

  return app;
}

/**
 * Keep-alive: periodically hit our own public /health so the host doesn't idle the
 * service out. On Render, RENDER_EXTERNAL_URL is injected automatically; override with
 * KEEPALIVE_URL, tune the interval with KEEPALIVE_MS (default 10 min), or disable by
 * setting KEEPALIVE_MS=0.
 */
function startKeepAlive(): void {
  const base = (process.env.KEEPALIVE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/+$/, "");
  const ms = Number(process.env.KEEPALIVE_MS ?? 600000);
  if (!base || !Number.isFinite(ms) || ms <= 0) {
    log.info("keepalive disabled", { hasUrl: !!base, ms });
    return;
  }
  const url = `${base}/health`;
  log.info("keepalive enabled", { url, ms });
  setInterval(() => {
    fetch(url)
      .then((r) => log.info("keepalive ping", { status: r.status }))
      .catch((e) => log.warn("keepalive failed", { err: String(e) }));
  }, ms);
}

/** Production entrypoint. */
export function start() {
  const cfg = loadConfig(process.env.CONFIG_PATH ?? "./config/peoplestrong.yml", process.env);
  const jobs = new JobStore();

  const app = buildApp({
    workerSecret: cfg.secrets.WORKER_SECRET,
    jobs,
    defaultStageFilter: cfg.stageFilter,
    runJob: (jobId, opts) => runScrape(jobId, opts, { cfg, jobs }),
  });

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => {
    log.info("worker listening", { port });
    startKeepAlive();
  });
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  start();
}
