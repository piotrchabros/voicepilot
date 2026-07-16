import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import dotenv from 'dotenv'
import { z } from 'zod'

/**
 * Process-level environment configuration (spec.md §4.6 / Plans.md 1.2):
 * secrets and config flow through `.env` + zod fail-fast, replacing the
 * previous ad-hoc `process.env[...]` reads scattered across main/pipeline.
 *
 * Validation is deliberately format-only for SONIOX_WS_URL — the EU-host
 * allowlist decision (spec.md §4.1) is `assertEuEndpoint`'s job
 * (src/pipeline/stt-soniox.ts), not this schema's. Duplicating that check
 * here would just create a second place to keep in sync.
 */
const BOOLEAN_FLAG = z.enum(['0', '1'])

const envSchema = z.object({
  SONIOX_API_KEY: z
    .string()
    .trim()
    .min(10, 'must be at least 10 characters (looks truncated/placeholder)')
    .optional(),
  SONIOX_WS_URL: z
    .string()
    .trim()
    .regex(/^wss:\/\//, 'must be a wss:// URL (EU-host allowlist is enforced separately)')
    .optional(),
  COPILOT_DEBUG: BOOLEAN_FLAG.optional(),
  COPILOT_DEMO: BOOLEAN_FLAG.optional(),
  COPILOT_NO_PROTECT: BOOLEAN_FLAG.optional(),
  COPILOT_PLACEHOLDER: BOOLEAN_FLAG.optional(),
  COPILOT_MIC_SPECULATE: BOOLEAN_FLAG.optional(),
  /**
   * Transport-B consent announcement script (spec.md §4 item 2, Plans.md
   * Task 4.1). This wording is a legal deliverable — docs/compliance.md item
   * 4 — and must never be invented by an agent. Unset/blank falls back to a
   * clearly-marked placeholder (`resolveAnnouncement` in ./consent); no
   * format constraint here beyond "not blank", since the real text's shape
   * isn't this schema's business.
   */
  CONSENT_ANNOUNCEMENT_PL: z.string().optional(),
  /**
   * Cloud analysis LLM (spec.md §4 item 8, Plans.md Task 6.3) — a second data
   * processor, off by default. Validation here is deliberately format-only,
   * same split as SONIOX_WS_URL above: the EU-allowlist/deployment-class
   * boot assertion (spec.md §4 item 8) is
   * `resolveCloudLlmConfig`/`assertEuLlmEndpoint`'s job
   * (src/pipeline/cloud-llm-client.ts), not this schema's. LLM_API_URL being
   * unset means the feature is simply unavailable — boot proceeds normally.
   */
  LLM_API_URL: z
    .string()
    .trim()
    .regex(/^https:\/\//, 'must be an https:// URL (EU allowlist is enforced separately)')
    .optional(),
  LLM_API_KEY: z
    .string()
    .trim()
    .min(10, 'must be at least 10 characters (looks truncated/placeholder)')
    .optional(),
  /** Vendor-specific region/deployment identifier (e.g. "eu-central-1", "EU Data Zone"). */
  LLM_DEPLOYMENT_CLASS: z.string().trim().optional(),
  /** Comma-separated EU hostname allowlist, e.g. "llm-eu.example.com,other-eu.example.com". */
  LLM_EU_HOST_ALLOWLIST: z.string().trim().optional(),
  /**
   * Comma-separated closed allowlist of accepted deployment-class values
   * (e.g. "eu-central-1,eu-west-1,EU Data Zone"). This is a **known-good
   * allowlist, not a known-bad denylist** — a novel value not present here is
   * rejected by default at boot (spec.md §4 item 8), same fail-closed
   * mechanism as LLM_EU_HOST_ALLOWLIST.
   */
  LLM_EU_DEPLOYMENT_CLASSES: z.string().trim().optional()
})

export type Env = z.infer<typeof envSchema>

const SCHEMA_KEYS = Object.keys(envSchema.shape)

/**
 * Blank values ("" or whitespace-only) are treated as unset, not invalid —
 * the same rule the pre-1.2 code applied via `.trim(); if (len > 0)`. This
 * matters because .env.example ships every key present but empty
 * (`SONIOX_API_KEY=`); copying it to `.env` untouched must still boot
 * cleanly (falling back to `.soniox-key`/local engine), not throw.
 */
function blankToUnset(raw: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: NodeJS.ProcessEnv = { ...raw }
  for (const key of SCHEMA_KEYS) {
    const value = normalized[key]
    if (value !== undefined && value.trim().length === 0) {
      delete normalized[key]
    }
  }
  return normalized
}

/**
 * Validates a raw environment object against the schema. Pure/sync — no
 * filesystem or Electron access — so it's directly testable with a plain
 * object, independent of `.env` file discovery or app.getAppPath().
 *
 * Fail-fast: throws a single Error listing every offending variable and why,
 * rather than surfacing one problem at a time. Unknown keys are ignored (zod
 * strips anything not declared in envSchema by default).
 */
export function validateEnv(raw: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(blankToUnset(raw))
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${details}`)
  }
  return result.data
}

/**
 * Resolves `.env`'s path: app root first (packaged/dev), else cwd. `app` is
 * only usable inside a running Electron process — falls back straight to cwd
 * under plain Node (e.g. vitest), mirroring config.ts's playbookDir pattern.
 */
function envFilePath(): string {
  if (typeof app !== 'undefined' && typeof app.getAppPath === 'function') {
    const atAppRoot = join(app.getAppPath(), '.env')
    if (existsSync(atAppRoot)) return atAppRoot
  }
  return join(process.cwd(), '.env')
}

/**
 * Loads `.env` (if present — never required, cloud STT is optional) and
 * validates process.env. Call at boot, synchronously, before app.whenReady()
 * / window creation, so a misconfigured secret fails the boot rather than
 * degrading silently mid-session (1.1 reviewer recommendation).
 *
 * Deliberately not memoized: config.ts's sonioxApiKey()/sonioxWsUrl() call
 * this on every read (as the pre-1.2 code did with process.env directly), so
 * tests that mutate process.env between assertions keep seeing live values.
 * dotenv.config() is idempotent — it never overwrites a key process.env
 * already has — so repeat calls are cheap and side-effect-free.
 */
export function loadEnv(): Env {
  const envPath = envFilePath()
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath })
  }
  return validateEnv(process.env)
}
