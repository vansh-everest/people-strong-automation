import { readFileSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";

const SelectorSchema = z.object({
  BASE_URL: z.string(),
  LOGIN_URL: z.string(),
  USERNAME_SELECTOR: z.string(),
  PASSWORD_SELECTOR: z.string(),
  LOGIN_BUTTON_SELECTOR: z.string(),
  LOGGED_IN_MARKER: z.string(),
  TASKS_ICON: z.string(),
  QUEUE_TITLE_TEXT: z.string(),
  TASK_LINK: z.string(),
  EXPENSE_HEAD_LINK: z.string(),
  ATTACHMENT_LINK: z.string(),
  TOTAL_CLAIMED_LABEL: z.string(),
  STAGE_FILTER: z.string(),
});

const SecretsSchema = z.object({
  WORKER_SECRET: z.string().min(1, "WORKER_SECRET is required"),
  PEOPLESTRONG_USER: z.string().min(1, "PEOPLESTRONG_USER is required"),
  PEOPLESTRONG_PASS: z.string().min(1, "PEOPLESTRONG_PASS is required"),
  SUPABASE_URL: z.string().url("SUPABASE_URL must be a URL"),
  SUPABASE_SERVICE_KEY: z.string().min(1, "SUPABASE_SERVICE_KEY is required"),
});

export type Selectors = z.infer<typeof SelectorSchema>;
export type Secrets = z.infer<typeof SecretsSchema>;

export interface AppConfig {
  selectors: Selectors;
  secrets: Secrets;
  stageFilter: string;
  storageDir: string;
  headless: boolean;
  bucket: string;
}

export function loadConfig(
  yamlPath: string,
  env: Record<string, string | undefined>
): AppConfig {
  const raw = yaml.load(readFileSync(yamlPath, "utf8"));
  const selectors = SelectorSchema.parse(raw);
  const secrets = SecretsSchema.parse(env);
  return {
    selectors,
    secrets,
    stageFilter: selectors.STAGE_FILTER,
    storageDir: env.STORAGE_DIR ?? "./storage",
    headless: (env.HEADLESS ?? "true") !== "false",
    bucket: "peoplestrong-claims",
  };
}
