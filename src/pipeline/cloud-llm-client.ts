import type { AnalysisLlm, AnalysisStreamOptions, Generation } from './analysis-llm'

/**
 * Cloud analysis LLM client (spec.md §4 item 8, §7; Plans.md Task 6.3). This
 * is a **second data processor** sitting on top of transcript/customer-brief
 * data — unlike Soniox (one hardcoded EU host, spec.md §4.1), the vendor here
 * is a recorded unknown (Plans.md unknown_data, docs/compliance.md "Cloud
 * analysis LLM (Phase 6) gate"), so the EU allowlist and deployment-class
 * requirement are fully config-driven and fail-closed: an unconfigured or
 * ambiguous allowlist refuses to start rather than silently allowing a
 * non-EU route through.
 *
 * The request/response shape is deliberately minimal and vendor-agnostic
 * (system + user prompt in, one text response out) — the real Analysis
 * prompt/schema and the streaming/session protocol for whichever vendor gets
 * selected are Task 6.4's job, not this one. Do not add a specific vendor's
 * wire format here before that decision lands (docs/compliance.md item 1).
 */

export interface CloudLlmConfig {
  apiUrl: string
  apiKey: string
  deploymentClass: string
  euHostAllowlist: string[]
  euDeploymentClassAllowlist: string[]
}

/**
 * The subset of `src/main/env.ts`'s validated `Env` this module reads.
 * Defined locally (not imported from env.ts) so this file has no dependency
 * on Electron's `app` module or any other env.ts internals — only the plain
 * string fields it actually needs, which keeps this testable with plain
 * object literals exactly like `validateEnv`'s own test suite does.
 */
export interface CloudLlmEnv {
  LLM_API_URL?: string
  LLM_API_KEY?: string
  LLM_DEPLOYMENT_CLASS?: string
  LLM_EU_HOST_ALLOWLIST?: string
  LLM_EU_DEPLOYMENT_CLASSES?: string
}

/** Parses a comma-separated list into a normalized (trimmed, lowercased, de-blanked) array. */
function parseCommaSeparatedList(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0)
}

/** Parses `LLM_EU_HOST_ALLOWLIST` (comma-separated hostnames) into a normalized list. */
export function parseEuHostAllowlist(raw: string | undefined): string[] {
  return parseCommaSeparatedList(raw)
}

/**
 * Parses `LLM_EU_DEPLOYMENT_CLASSES` (comma-separated accepted deployment-class
 * values, e.g. "eu-central-1,eu-west-1,eu data zone") into a normalized list.
 */
export function parseEuDeploymentClassAllowlist(raw: string | undefined): string[] {
  return parseCommaSeparatedList(raw)
}

/**
 * True only when `deploymentClass` exactly matches (case/whitespace-insensitive)
 * an entry in `euDeploymentClassAllowlist`. This is a **closed allowlist of
 * known-good values**, not a denylist of known-bad ones (spec.md §4 item 8):
 * a novel, never-seen deployment-class string must be rejected by default,
 * not accepted because it merely fails to match a "global"-shaped pattern.
 * The allowlist is config-driven (not a fixed vendor enum) so this survives
 * vendor selection (docs/compliance.md item 1, still unknown) without another
 * code change — the same mechanism `parseEuHostAllowlist` already uses for
 * hostnames.
 */
export function isEuDeploymentClass(
  deploymentClass: string,
  euDeploymentClassAllowlist: string[]
): boolean {
  const trimmed = deploymentClass.trim().toLowerCase()
  if (trimmed.length === 0) return false
  return euDeploymentClassAllowlist.includes(trimmed)
}

/**
 * Boot-time assertion (spec.md §4 item 8): refuses to start unless the
 * resolved cloud analysis LLM endpoint is https, its hostname is present in
 * the configured EU host allowlist, and the deployment-class field exactly
 * matches an entry in the configured EU deployment-class allowlist. Mirrors
 * `assertEuEndpoint` in stt-soniox.ts, except both allowlists are
 * config-driven rather than a single hardcoded host, because the vendor here
 * is a recorded unknown. Both allowlists are **closed allowlists of
 * known-good values** — an empty/missing allowlist, or a value not present
 * in it, refuses to start; nothing is accepted by merely failing to look bad.
 */
export function assertEuLlmEndpoint(
  apiUrl: string,
  deploymentClass: string,
  euHostAllowlist: string[],
  euDeploymentClassAllowlist: string[]
): string {
  let parsed: URL
  try {
    parsed = new URL(apiUrl)
  } catch {
    throw new Error(
      `Invalid cloud analysis LLM URL "${apiUrl}" — must be an https:// URL in the configured EU allowlist (spec.md §4 item 8).`
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(
      `Refusing to start: cloud analysis LLM endpoint "${apiUrl}" is not https — plain HTTP is never permitted (spec.md §4 item 8).`
    )
  }
  if (euHostAllowlist.length === 0) {
    throw new Error(
      'Refusing to start: LLM_EU_HOST_ALLOWLIST is empty/missing while a cloud analysis LLM endpoint is configured — the EU allowlist is fail-closed by design (spec.md §4 item 8, docs/compliance.md "Cloud analysis LLM (Phase 6) gate").'
    )
  }
  if (!euHostAllowlist.includes(parsed.hostname.toLowerCase())) {
    throw new Error(
      `Refusing to start: cloud analysis LLM host "${parsed.hostname}" is not in the configured EU allowlist (spec.md §4 item 8, EU data residency).`
    )
  }
  if (euDeploymentClassAllowlist.length === 0) {
    throw new Error(
      'Refusing to start: LLM_EU_DEPLOYMENT_CLASSES is empty/missing while a cloud analysis LLM endpoint is configured — the deployment-class allowlist is fail-closed by design, same as the host allowlist (spec.md §4 item 8, docs/compliance.md "Cloud analysis LLM (Phase 6) gate").'
    )
  }
  if (!isEuDeploymentClass(deploymentClass, euDeploymentClassAllowlist)) {
    throw new Error(
      `Refusing to start: cloud analysis LLM deployment class "${deploymentClass}" is not in the configured EU deployment-class allowlist — a novel or "global"/"Global Standard"-style value is disqualifying by default, even on an EU-allowlisted host (spec.md §4 item 8).`
    )
  }
  return apiUrl
}

/**
 * Resolves the cloud analysis LLM config from validated env. Returns `null`
 * when `LLM_API_URL` is unset — the feature is simply unavailable and boot
 * proceeds normally (fail-closed for the FEATURE, not the app, matching the
 * existing "cloud STT is optional" contract in env.ts). Once the URL IS set,
 * every other field becomes required; misconfiguration throws so boot fails
 * loudly rather than silently degrading — the same contract config.ts
 * applies to `sonioxWsUrl()`/`assertEuEndpoint`.
 */
export function resolveCloudLlmConfig(env: CloudLlmEnv): CloudLlmConfig | null {
  const apiUrl = env.LLM_API_URL
  if (apiUrl === undefined) return null
  if (env.LLM_API_KEY === undefined) {
    throw new Error(
      'Refusing to start: LLM_API_URL is set but LLM_API_KEY is missing — a cloud analysis LLM endpoint requires an API key (spec.md §4 item 8).'
    )
  }
  const deploymentClass = env.LLM_DEPLOYMENT_CLASS ?? ''
  const euHostAllowlist = parseEuHostAllowlist(env.LLM_EU_HOST_ALLOWLIST)
  const euDeploymentClassAllowlist = parseEuDeploymentClassAllowlist(env.LLM_EU_DEPLOYMENT_CLASSES)
  assertEuLlmEndpoint(apiUrl, deploymentClass, euHostAllowlist, euDeploymentClassAllowlist)
  return {
    apiUrl,
    apiKey: env.LLM_API_KEY,
    deploymentClass,
    euHostAllowlist,
    euDeploymentClassAllowlist
  }
}

/**
 * HTTP implementation of `AnalysisLlm`. `Generation.cancel()` aborts the
 * in-flight `fetch` via `AbortController` — the same mechanism
 * `LlamaClient.streamHint` uses — so AnalysisEngine (Task 6.4) can apply
 * identical cancel-previous handling to both the local and cloud paths.
 *
 * Log hygiene (spec.md §7): HTTP error paths below never read or include the
 * response body in a thrown message — a failed call must not dump its
 * request/response payload into a log or an error string that a caller might
 * log. This client also never logs anything itself.
 */
export class CloudLlmClient implements AnalysisLlm {
  private readonly config: CloudLlmConfig

  constructor(config: CloudLlmConfig) {
    // Defense-in-depth, mirrors SonioxStt's constructor-time
    // assertEuEndpoint call: even a caller that builds a CloudLlmConfig by
    // hand (bypassing resolveCloudLlmConfig) cannot construct a client
    // pointed at a non-EU/plain-http endpoint.
    assertEuLlmEndpoint(
      config.apiUrl,
      config.deploymentClass,
      config.euHostAllowlist,
      config.euDeploymentClassAllowlist
    )
    this.config = config
  }

  generate(
    systemPrompt: string,
    userPrompt: string,
    onToken: (tok: string) => void,
    opts: AnalysisStreamOptions = {}
  ): Generation {
    const controller = new AbortController()
    let cancelled = false

    const done = this.run(
      systemPrompt,
      userPrompt,
      onToken,
      controller.signal,
      () => cancelled,
      opts
    ).catch(() => {
      // Aborted/failed generations settle quietly — Generation.done "never
      // rejects" is the contract every AnalysisLlm implementation must keep
      // (mirrors LlamaClient.streamHint). Surfacing real errors to the
      // caller is a later task's concern (AnalysisEngine telemetry, 6.4),
      // not this narrow client's.
    })

    return {
      cancel: () => {
        if (cancelled) return
        cancelled = true
        controller.abort()
      },
      done,
      isCancelled: () => cancelled
    }
  }

  private async run(
    systemPrompt: string,
    userPrompt: string,
    onToken: (tok: string) => void,
    signal: AbortSignal,
    isCancelled: () => boolean,
    opts: AnalysisStreamOptions
  ): Promise<void> {
    const res = await fetch(this.config.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.apiKey}`
      },
      body: JSON.stringify({ system_prompt: systemPrompt, user_prompt: userPrompt }),
      signal
    })
    if (isCancelled()) return
    if (!res.ok) {
      // Status code only — the body is never read on the error path, so
      // there is nothing here that could leak request/response content.
      throw new Error(`cloud analysis LLM request failed: HTTP ${res.status}`)
    }
    let text: string
    try {
      const json = (await res.json()) as { text?: unknown }
      text = typeof json.text === 'string' ? json.text : ''
    } catch {
      // Malformed body — same rule: never surface the raw response text.
      throw new Error('cloud analysis LLM request failed: malformed response body')
    }
    if (isCancelled()) return
    if (text.length > 0) {
      opts.onFirstToken?.()
      onToken(text)
    }
  }
}
