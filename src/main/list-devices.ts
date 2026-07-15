import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { sidecarBinary } from './config'

// `--list-devices`: delegate to the Swift sidecar's own enumeration (it owns the
// AVFoundation device list) and print it. Mirrors Main.java's --list-devices.
export async function runListDevices(): Promise<void> {
  const bin = sidecarBinary()
  if (!existsSync(bin)) {
    console.error(`capture sidecar not built at ${bin}\nBuild it first:  npm run sidecar`)
    return
  }
  const res = spawnSync(bin, ['--list-devices'], { encoding: 'utf8' })
  if (res.status !== 0) {
    console.error(res.stderr || `sidecar exited ${res.status}`)
    return
  }
  process.stdout.write(res.stdout)
}
