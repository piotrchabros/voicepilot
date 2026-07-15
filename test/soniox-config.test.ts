import { afterEach, describe, expect, it } from 'vitest'
import { sonioxWsUrl } from '../src/main/config'

// Compliance requirement (spec.md §4.1): a misconfigured SONIOX_WS_URL must
// fail loudly at config-resolution time (main-process boot), not degrade
// silently to whatever WebSocket target ends up being used.
describe('sonioxWsUrl (main-process boot assertion)', () => {
  afterEach(() => {
    delete process.env['SONIOX_WS_URL']
  })

  it('defaults to the EU endpoint when unset', () => {
    delete process.env['SONIOX_WS_URL']
    expect(sonioxWsUrl()).toBe('wss://stt-rt.eu.soniox.com/transcribe-websocket')
  })

  it('accepts an explicit EU endpoint override', () => {
    process.env['SONIOX_WS_URL'] = 'wss://stt-rt.eu.soniox.com/transcribe-websocket'
    expect(sonioxWsUrl()).toBe('wss://stt-rt.eu.soniox.com/transcribe-websocket')
  })

  it('throws — refusing to resolve config — for the global (non-EU) endpoint', () => {
    process.env['SONIOX_WS_URL'] = 'wss://stt-rt.soniox.com/transcribe-websocket'
    expect(() => sonioxWsUrl()).toThrow(/stt-rt\.eu\.soniox\.com/)
  })

  it('throws for a non-TLS (ws://) scheme', () => {
    process.env['SONIOX_WS_URL'] = 'ws://stt-rt.eu.soniox.com/transcribe-websocket'
    expect(() => sonioxWsUrl()).toThrow()
  })

  it('throws for an unrelated domain', () => {
    process.env['SONIOX_WS_URL'] = 'wss://evil.example.com/transcribe-websocket'
    expect(() => sonioxWsUrl()).toThrow()
  })
})
