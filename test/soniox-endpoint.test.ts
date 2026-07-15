import { describe, expect, it } from 'vitest'
import { assertEuEndpoint, EU_SONIOX_WS_URL } from '../src/pipeline/stt-soniox'

// Compliance requirement (spec.md §4.1): boot must refuse to start unless the
// Soniox WS endpoint resolves to the documented EU host. No silent fallback
// to the global endpoint.
describe('assertEuEndpoint', () => {
  it('accepts the documented EU host', () => {
    expect(assertEuEndpoint(EU_SONIOX_WS_URL)).toBe(EU_SONIOX_WS_URL)
    expect(assertEuEndpoint('wss://stt-rt.eu.soniox.com/transcribe-websocket')).toBe(
      'wss://stt-rt.eu.soniox.com/transcribe-websocket'
    )
  })

  it('rejects the global (non-EU) endpoint', () => {
    expect(() => assertEuEndpoint('wss://stt-rt.soniox.com/transcribe-websocket')).toThrow()
  })

  it('rejects a typo host', () => {
    expect(() => assertEuEndpoint('wss://stt-rt.eu.sonoix.com/transcribe-websocket')).toThrow()
  })

  it('rejects an unrelated domain', () => {
    expect(() => assertEuEndpoint('wss://evil.example.com/transcribe-websocket')).toThrow()
  })

  it('rejects a hostname that merely contains the EU host as a prefix-lookalike', () => {
    expect(() => assertEuEndpoint('wss://evil-stt-rt.eu.soniox.com/transcribe-websocket')).toThrow()
  })

  it('rejects a hostname that appends the EU host as a subdomain of an attacker domain', () => {
    expect(() =>
      assertEuEndpoint('wss://stt-rt.eu.soniox.com.evil.example/transcribe-websocket')
    ).toThrow()
  })

  it('rejects a non-TLS (ws://) scheme even against the correct host', () => {
    expect(() => assertEuEndpoint('ws://stt-rt.eu.soniox.com/transcribe-websocket')).toThrow()
  })

  it('rejects empty/undefined input by falling back to the EU default', () => {
    expect(assertEuEndpoint(undefined)).toBe(EU_SONIOX_WS_URL)
    expect(assertEuEndpoint('')).toBe(EU_SONIOX_WS_URL)
  })

  it('throws an actionable message naming the allowed host', () => {
    try {
      assertEuEndpoint('wss://stt-rt.soniox.com/transcribe-websocket')
      throw new Error('expected assertEuEndpoint to throw')
    } catch (e) {
      expect((e as Error).message).toMatch(/stt-rt\.eu\.soniox\.com/)
    }
  })
})
