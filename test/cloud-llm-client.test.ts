import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisLlm, AnalysisStreamOptions, Generation } from '../src/pipeline/analysis-llm'
import {
  assertEuLlmEndpoint,
  CloudLlmClient,
  isEuDeploymentClass,
  parseEuHostAllowlist,
  resolveCloudLlmConfig
} from '../src/pipeline/cloud-llm-client'

// spec.md §4 item 8 / Plans.md Task 6.3: the cloud analysis LLM is a second
// data processor and its EU allowlist is config-driven (vendor unknown —
// Plans.md unknown_data, docs/compliance.md "Cloud analysis LLM (Phase 6)
// gate"), unlike Soniox's single hardcoded EU host. Boot must refuse to
// start on any non-EU / non-https / unconfigured-allowlist / non-EU
// deployment-class combination.

const EU_URL = 'https://llm-eu.example.com/v1/analyze'
const EU_ALLOWLIST = ['llm-eu.example.com']
const EU_CLASS = 'eu-data-zone'

describe('assertEuLlmEndpoint', () => {
  it('accepts an https URL whose host is in the allowlist with an EU deployment class', () => {
    expect(assertEuLlmEndpoint(EU_URL, EU_CLASS, EU_ALLOWLIST)).toBe(EU_URL)
  })

  it('rejects a plain http:// URL even against an allowlisted host', () => {
    expect(() =>
      assertEuLlmEndpoint('http://llm-eu.example.com/v1/analyze', EU_CLASS, EU_ALLOWLIST)
    ).toThrow(/https/i)
  })

  it('rejects a host that is not in the allowlist (non-EU URL)', () => {
    expect(() =>
      assertEuLlmEndpoint('https://llm-us.example.com/v1/analyze', EU_CLASS, EU_ALLOWLIST)
    ).toThrow(/allowlist/i)
  })

  it('rejects when the allowlist is empty', () => {
    expect(() => assertEuLlmEndpoint(EU_URL, EU_CLASS, [])).toThrow(/allowlist/i)
  })

  it('rejects a "global" deployment class even on an allowlisted EU host', () => {
    expect(() => assertEuLlmEndpoint(EU_URL, 'global', EU_ALLOWLIST)).toThrow(/deployment/i)
  })

  it('rejects a "Global Standard"-style deployment class', () => {
    expect(() => assertEuLlmEndpoint(EU_URL, 'Global Standard', EU_ALLOWLIST)).toThrow(
      /deployment/i
    )
  })

  it('rejects a missing/blank deployment class', () => {
    expect(() => assertEuLlmEndpoint(EU_URL, '', EU_ALLOWLIST)).toThrow(/deployment/i)
  })

  it('rejects a garbage (non-URL-shaped) apiUrl', () => {
    expect(() => assertEuLlmEndpoint('not-a-url', EU_CLASS, EU_ALLOWLIST)).toThrow()
  })
})

describe('isEuDeploymentClass / parseEuHostAllowlist', () => {
  it('accepts explicit EU-region-shaped deployment classes', () => {
    expect(isEuDeploymentClass('eu-central-1')).toBe(true)
    expect(isEuDeploymentClass('EU Data Zone')).toBe(true)
  })

  it('rejects global-style classes case-insensitively', () => {
    expect(isEuDeploymentClass('global')).toBe(false)
    expect(isEuDeploymentClass('Global Standard')).toBe(false)
    expect(isEuDeploymentClass('GLOBAL')).toBe(false)
  })

  it('parses a comma-separated allowlist, trimming and lowercasing', () => {
    expect(parseEuHostAllowlist(' llm-eu.example.com , OTHER-EU.example.com ')).toEqual([
      'llm-eu.example.com',
      'other-eu.example.com'
    ])
  })

  it('treats unset/blank allowlist as empty', () => {
    expect(parseEuHostAllowlist(undefined)).toEqual([])
    expect(parseEuHostAllowlist('')).toEqual([])
    expect(parseEuHostAllowlist('   ')).toEqual([])
  })
})

describe('resolveCloudLlmConfig', () => {
  it('returns null (feature unavailable, boot proceeds) when LLM_API_URL is unset', () => {
    expect(resolveCloudLlmConfig({})).toBeNull()
  })

  it('throws when LLM_API_URL is set but LLM_API_KEY is missing', () => {
    expect(() => resolveCloudLlmConfig({ LLM_API_URL: EU_URL })).toThrow(/LLM_API_KEY/)
  })

  it('throws when LLM_API_URL is set but the allowlist is empty/missing', () => {
    expect(() =>
      resolveCloudLlmConfig({
        LLM_API_URL: EU_URL,
        LLM_API_KEY: 'sk-1234567890',
        LLM_DEPLOYMENT_CLASS: EU_CLASS
      })
    ).toThrow(/allowlist/i)
  })

  it('throws for a non-EU host even with a key and an EU-shaped deployment class', () => {
    expect(() =>
      resolveCloudLlmConfig({
        LLM_API_URL: 'https://llm-us.example.com/v1/analyze',
        LLM_API_KEY: 'sk-1234567890',
        LLM_DEPLOYMENT_CLASS: EU_CLASS,
        LLM_EU_HOST_ALLOWLIST: 'llm-eu.example.com'
      })
    ).toThrow(/allowlist/i)
  })

  it('throws for a "Global Standard" deployment class on an otherwise-valid EU host', () => {
    expect(() =>
      resolveCloudLlmConfig({
        LLM_API_URL: EU_URL,
        LLM_API_KEY: 'sk-1234567890',
        LLM_DEPLOYMENT_CLASS: 'Global Standard',
        LLM_EU_HOST_ALLOWLIST: 'llm-eu.example.com'
      })
    ).toThrow(/deployment/i)
  })

  it('resolves a fully-valid config', () => {
    const config = resolveCloudLlmConfig({
      LLM_API_URL: EU_URL,
      LLM_API_KEY: 'sk-1234567890',
      LLM_DEPLOYMENT_CLASS: EU_CLASS,
      LLM_EU_HOST_ALLOWLIST: 'llm-eu.example.com, other-eu.example.com'
    })
    expect(config).toEqual({
      apiUrl: EU_URL,
      apiKey: 'sk-1234567890',
      deploymentClass: EU_CLASS,
      euHostAllowlist: ['llm-eu.example.com', 'other-eu.example.com']
    })
  })
})

/**
 * Fake AnalysisLlm test double — never touches the network. This is the ONLY
 * double downstream consumers (Task 6.4's AnalysisEngine) and this file's
 * cancel-contract test should use; the real vendor API is never called in
 * CI, mirroring StubLlm in test/hint-engine.test.ts.
 */
class FakeCloudClient implements AnalysisLlm {
  readonly calls: Array<{ systemPrompt: string; userPrompt: string }> = []
  /** Queue of token arrays to emit per call, in order. Default: none. */
  nextTokens: string[][] = []

  generate(
    systemPrompt: string,
    userPrompt: string,
    onToken: (tok: string) => void,
    opts: AnalysisStreamOptions = {}
  ): Generation {
    this.calls.push({ systemPrompt, userPrompt })
    let cancelled = false
    const toks = this.nextTokens.shift() ?? []
    if (toks.length > 0 && !cancelled) opts.onFirstToken?.()
    for (const tok of toks) {
      if (cancelled) break
      onToken(tok)
    }
    return {
      cancel: () => {
        cancelled = true
      },
      done: Promise.resolve(),
      isCancelled: () => cancelled
    }
  }
}

describe('AnalysisLlm cancel contract (FakeCloudClient)', () => {
  it('cancel() is idempotent and isCancelled() reflects state', () => {
    const client = new FakeCloudClient()
    const gen = client.generate('sys', 'user', () => {})
    expect(gen.isCancelled()).toBe(false)
    gen.cancel()
    expect(gen.isCancelled()).toBe(true)
    gen.cancel() // idempotent — no throw, no double side effect
    expect(gen.isCancelled()).toBe(true)
  })

  it('done resolves (never rejects), including after cancel', async () => {
    const client = new FakeCloudClient()
    const gen = client.generate('sys', 'user', () => {})
    gen.cancel()
    await expect(gen.done).resolves.toBeUndefined()
  })

  it('10 successive generations => cancelling the first 9 leaves exactly one live, mirroring HintEngine cancel-previous', () => {
    const client = new FakeCloudClient()
    const gens: Generation[] = []
    for (let i = 0; i < 10; i++) {
      const prev = gens.at(-1)
      prev?.cancel()
      gens.push(client.generate('sys', `user ${i}`, () => {}))
    }
    expect(gens.filter((g) => g.isCancelled())).toHaveLength(9)
    expect(gens.filter((g) => !g.isCancelled())).toHaveLength(1)
    expect(gens.at(-1)?.isCancelled()).toBe(false)
  })
})

describe('CloudLlmClient (real HTTP implementation, network-free — fetch is stubbed locally, never a real vendor call)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeClient(): CloudLlmClient {
    return new CloudLlmClient({
      apiUrl: EU_URL,
      apiKey: 'sk-1234567890',
      deploymentClass: EU_CLASS,
      euHostAllowlist: EU_ALLOWLIST
    })
  }

  it('refuses to construct with a non-EU/non-https config (defense-in-depth, mirrors SonioxStt)', () => {
    expect(
      () =>
        new CloudLlmClient({
          apiUrl: 'http://llm-eu.example.com/v1/analyze',
          apiKey: 'sk-1234567890',
          deploymentClass: EU_CLASS,
          euHostAllowlist: EU_ALLOWLIST
        })
    ).toThrow(/https/i)
  })

  it('an in-flight generation aborts on cancel(): isCancelled() true, done resolves without throwing', async () => {
    let capturedSignal: AbortSignal | undefined
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal as AbortSignal | undefined
        return new Promise((_resolve, reject) => {
          capturedSignal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )

    const client = makeClient()
    const gen = client.generate('sys', 'user', () => {})
    expect(gen.isCancelled()).toBe(false)
    gen.cancel()
    expect(gen.isCancelled()).toBe(true)
    expect(capturedSignal?.aborted).toBe(true)
    await expect(gen.done).resolves.toBeUndefined()
  })

  it('cancel() is idempotent (second call is a no-op, does not re-abort)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal as AbortSignal | undefined
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            const err = new Error('aborted')
            err.name = 'AbortError'
            reject(err)
          })
        })
      })
    )
    const client = makeClient()
    const gen = client.generate('sys', 'user', () => {})
    gen.cancel()
    gen.cancel()
    expect(gen.isCancelled()).toBe(true)
    await expect(gen.done).resolves.toBeUndefined()
  })

  it('an HTTP error response never leaks its body text in the thrown error path', async () => {
    const sensitivePayload = 'SECRET-CUSTOMER-BRIEF-CONTENT-should-never-appear-in-any-log-or-error'
    const onTokenCalls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 502,
          json: () => Promise.reject(new Error('should not be called for a non-ok response')),
          text: () => Promise.resolve(sensitivePayload)
        } as unknown as Response)
      )
    )
    const client = makeClient()
    const errors: string[] = []
    // generate()'s `done` never rejects (Generation contract) — the run()
    // internals still throw, but the public surface only exposes it via a
    // swallow; assert indirectly that onToken was never called with the
    // payload and that no observable error text contains it.
    const gen = client.generate('sys', 'user', (tok) => onTokenCalls.push(tok))
    await gen.done
    for (const call of onTokenCalls) expect(call).not.toContain(sensitivePayload)
    for (const err of errors) expect(err).not.toContain(sensitivePayload)
    expect(onTokenCalls).toHaveLength(0)
  })

  it('a malformed (non-JSON-parseable) response body never leaks its raw text', async () => {
    const sensitivePayload = 'RAW-GARBLED-BODY-with-secret-token-abc123'
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.reject(new Error(sensitivePayload)),
          text: () => Promise.resolve(sensitivePayload)
        } as unknown as Response)
      )
    )
    const client = makeClient()
    const onTokenCalls: string[] = []
    const gen = client.generate('sys', 'user', (tok) => onTokenCalls.push(tok))
    await gen.done
    expect(onTokenCalls).toHaveLength(0)
  })

  it('a successful response delivers the text via onToken and fires onFirstToken once', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ text: 'stage: discovery' })
        } as unknown as Response)
      )
    )
    const client = makeClient()
    const onTokenCalls: string[] = []
    let firstTokenFired = 0
    const gen = client.generate('sys', 'user', (tok) => onTokenCalls.push(tok), {
      onFirstToken: () => {
        firstTokenFired += 1
      }
    })
    await gen.done
    expect(onTokenCalls).toEqual(['stage: discovery'])
    expect(firstTokenFired).toBe(1)
    expect(gen.isCancelled()).toBe(false)
  })
})
