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
}

/**
 * The subset of `src/main/env.ts`'s validated `Env` this module reads.
 * Defined locally (not imported from env.ts) so this file has no dependency
 * on Electron's `app` module or any other env.ts internals — only the four
 * plain string fields it actually needs, which keeps this testable with
 * plain object literals exactly like `validateEnv`'s own test suite does.
 */
export interface CloudLlmEnv {
  LLM_API_URL?: string
  LLM_API_KEY?: string
  LLM_DEPLOYMENT_CLASS?: string
  LLM_EU_HOST_ALLOWLIST?: string
}

/**
 * Deployment-class values that look EU-adjacent but are actually
 * global/non-regional routing (spec.md §4 item 8: "Azure 'Global Standard' /
 * Vertex 'global' routes are disqualifying even on EU-looking hosts").
 * Pattern-based (not a fixed vendor enum) so this survives vendor selection
 * (docs/compliance.md item 1, still unknown) without another code change.
 */
const DISQUALIFYING_DEPLOYMENT_CLASS_PATTERN = /\bglobal\b/i

/** True when `deploymentClass` is non-blank and not an explicitly-global/non-regional route. */
export function isEuDeploymentClass(deploymentClass: string): boolean {
  const trimmed = deploymentClass.trim()
  if (trimmed.length === 0) return false
  return !DISQUALIFYING_DEPLOYMENT_CLASS_PATTERN.test(trimmed)
}

/** Parses `LLM_EU_HOST_ALLOWLIST` (comma-separated hostnames) into a normalized list. */
export function parseEuHostAllowlist(raw: string | undefined): string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
}

/**
 * Boot-time assertion (spec.md §4 item 8): refuses to start unless the
 * resolved cloud analysis LLM endpoint is https, its hostname is present in
 * the configured EU allowlist, and the deployment-class field is an
 * explicitly-EU value. Mirrors `assertEuEndpoint` in stt-soniox.ts, except
 * the allowlist is config-driven rather than a single hardcoded host,
 * because the vendor here is a recorded unknown.
 */
export function assertEuLlmEndpoint(
  apiUrl: string,
  deploymentClass: string,
  euHostAllowlist: string[]
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
  if (!isEuDeploymentClass(deploymentClass)) {
    throw new Error(
      `Refusing to start: cloud analysis LLM deployment class "${deploymentClass}" is not an explicitly-EU deployment — "global"/"Global Standard"-style routing is disqualifying even on an EU-allowlisted host (spec.md §4 item 8).`
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
  assertEuLlmEndpoint(apiUrl, deploymentClass, euHostAllowlist)
  return { apiUrl, apiKey: env.LLM_API_KEY, deploymentClass, euHostAllowlist }
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
    assertEuLlmEndpoint(config.apiUrl, config.deploymentClass, config.euHostAllowlist)
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
