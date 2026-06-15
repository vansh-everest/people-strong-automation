import express, { type Request, type Response, type NextFunction } from "express";
import { JobStore } from "./jobs.js";
import { ClaimStore } from "./storage.js";
import { createSupabase } from "./supabase.js";
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

  app.post("/sync-claims", auth, async (req, res) => {
    const stageFilter: string | null = req.body?.stageFilter ?? deps.defaultStageFilter;
    const limit: number | null =
      typeof req.body?.limit === "number" ? req.body.limit : null;

    if (!deps.jobs.tryAcquire()) {
      return res.status(409).json({ error: "a sync job is already running" });
    }

    let jobId: string;
    try {
      const job = await deps.jobs.create({ stageFilter, limit });
      jobId = job.id;
    } catch (err) {
      deps.jobs.release();
      return res.status(500).json({ error: String(err) });
    }

    // Fire-and-forget; always release the guard when done.
    deps
      .runJob(jobId, { stageFilter, limit })
      .catch((err) => log.error("runJob crashed", { jobId, err: String(err) }))
      .finally(() => deps.jobs.release());

    return res.status(202).json({ jobId });
  });

  app.get("/job/:id", auth, async (req, res) => {
    const job = await deps.jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: "not found" });
    return res.json({
      status: job.status,
      progress: job.progress,
      results: job.results ?? undefined,
      error: job.error ?? undefined,
    });
  });

  return app;
}

/** Production entrypoint. */
export function start() {
  const cfg = loadConfig(process.env.CONFIG_PATH ?? "./config/peoplestrong.yml", process.env);
  const supabase = createSupabase(cfg.secrets);
  const jobs = new JobStore(supabase);
  const claimStore = new ClaimStore(supabase, cfg.bucket);

  const app = buildApp({
    workerSecret: cfg.secrets.WORKER_SECRET,
    jobs,
    defaultStageFilter: cfg.stageFilter,
    runJob: (jobId, opts) => runScrape(jobId, opts, { cfg, jobs, claimStore }),
  });

  const port = Number(process.env.PORT ?? 8080);
  app.listen(port, () => log.info("worker listening", { port }));
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  start();
}
