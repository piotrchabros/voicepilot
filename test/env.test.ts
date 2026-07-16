import { describe, expect, it } from 'vitest'
import { validateEnv } from '../src/main/env'

// Plans.md 1.2 / spec.md §4.6: secrets consolidate through .env + zod
// fail-fast. These cases exercise validateEnv directly (no filesystem/
// Electron dependency) so they run in plain Node under vitest.
describe('validateEnv', () => {
  it('accepts an empty environment — every field is optional', () => {
    expect(() => validateEnv({})).not.toThrow()
    expect(validateEnv({})).toEqual({})
  })

  it('accepts a fully-populated valid environment', () => {
    const raw = {
      SONIOX_API_KEY: 'sk-1234567890abcdef',
      SONIOX_WS_URL: 'wss://stt-rt.eu.soniox.com/transcribe-websocket',
      COPILOT_DEBUG: '1',
      COPILOT_DEMO: '0',
      COPILOT_NO_PROTECT: '0',
      COPILOT_PLACEHOLDER: '1',
      COPILOT_MIC_SPECULATE: '0'
    }
    expect(validateEnv(raw)).toEqual(raw)
  })

  it('ignores unrelated/unknown keys (e.g. PATH, HOME)', () => {
    const raw = { PATH: '/usr/bin', HOME: '/Users/x', SONIOX_API_KEY: 'sk-1234567890' }
    const parsed = validateEnv(raw)
    expect(parsed).toEqual({ SONIOX_API_KEY: 'sk-1234567890' })
  })

  it('throws — naming the variable — when SONIOX_API_KEY is too short', () => {
    expect(() => validateEnv({ SONIOX_API_KEY: 'short' })).toThrow(/SONIOX_API_KEY/)
  })

  it('throws — naming the variable — for a malformed SONIOX_WS_URL (not wss://)', () => {
    expect(() =>
      validateEnv({ SONIOX_WS_URL: 'https://stt-rt.eu.soniox.com/transcribe-websocket' })
    ).toThrow(/SONIOX_WS_URL/)
  })

  it('throws for a garbage (non-URL-shaped) SONIOX_WS_URL', () => {
    expect(() => validateEnv({ SONIOX_WS_URL: 'not-a-url' })).toThrow(/SONIOX_WS_URL/)
  })

  it('throws — naming the variable — for a COPILOT_* flag outside 0/1', () => {
    expect(() => validateEnv({ COPILOT_DEBUG: 'true' })).toThrow(/COPILOT_DEBUG/)
  })

  it('treats blank values as unset — copying .env.example untouched must still boot', () => {
    // .env.example ships every key present but empty (`SONIOX_API_KEY=`);
    // dotenv parses that as an empty string, not "absent".
    const raw = {
      SONIOX_API_KEY: '',
      SONIOX_WS_URL: '   ',
      COPILOT_DEBUG: ''
    }
    expect(() => validateEnv(raw)).not.toThrow()
    expect(validateEnv(raw)).toEqual({})
  })

  it('accepts a valid LLM_API_URL (https://) and LLM_API_KEY plus both allowlists', () => {
    const raw = {
      LLM_API_URL: 'https://llm-eu.example.com/v1/analyze',
      LLM_API_KEY: 'sk-1234567890',
      LLM_DEPLOYMENT_CLASS: 'eu-central-1',
      LLM_EU_HOST_ALLOWLIST: 'llm-eu.example.com',
      LLM_EU_DEPLOYMENT_CLASSES: 'eu-central-1,eu-west-1'
    }
    expect(validateEnv(raw)).toEqual(raw)
  })

  it('rejects a plain http:// LLM_API_URL — https is enforced at parse time (spec.md §4 item 8)', () => {
    expect(() => validateEnv({ LLM_API_URL: 'http://llm-eu.example.com/v1/analyze' })).toThrow(
      /LLM_API_URL/
    )
  })

  it('rejects a too-short LLM_API_KEY', () => {
    expect(() => validateEnv({ LLM_API_KEY: 'short' })).toThrow(/LLM_API_KEY/)
  })

  it('treats a blank LLM_API_URL as unset, same as the other optional fields', () => {
    expect(validateEnv({ LLM_API_URL: '   ' })).toEqual({})
  })

  // Plans.md Task 6.4 / spec.md §7 cloud-send feature flag — same
  // fail-closed BOOLEAN_FLAG pattern as COPILOT_DEBUG et al above.
  it('accepts LLM_ANALYSIS_ENABLED="0" and "1"', () => {
    expect(validateEnv({ LLM_ANALYSIS_ENABLED: '0' })).toEqual({ LLM_ANALYSIS_ENABLED: '0' })
    expect(validateEnv({ LLM_ANALYSIS_ENABLED: '1' })).toEqual({ LLM_ANALYSIS_ENABLED: '1' })
  })

  it('rejects LLM_ANALYSIS_ENABLED="true" — naming the variable, BOOLEAN_FLAG is 0/1 only', () => {
    expect(() => validateEnv({ LLM_ANALYSIS_ENABLED: 'true' })).toThrow(/LLM_ANALYSIS_ENABLED/)
  })

  it('treats a blank LLM_ANALYSIS_ENABLED as unset, same as the other flags', () => {
    expect(validateEnv({ LLM_ANALYSIS_ENABLED: '' })).toEqual({})
  })

  it('reports every offending variable in one throw, not just the first', () => {
    expect.assertions(2)
    try {
      validateEnv({ SONIOX_API_KEY: 'x', COPILOT_DEBUG: 'yes' })
    } catch (err) {
      const message = (err as Error).message
      expect(message).toMatch(/SONIOX_API_KEY/)
      expect(message).toMatch(/COPILOT_DEBUG/)
    }
  })
})
