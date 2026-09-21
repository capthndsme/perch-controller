import type WifiAccessPoint from '#models/wifi_access_point'
import { DateTime } from 'luxon'
import { spawn } from 'node:child_process'
import db from '@adonisjs/lucid/services/db'

export type WifiCommandResult = {
  ok: boolean
  stdout: string
  stderr: string
  latencyMs: number
  error?: string
}

type RunSshOptions = {
  timeoutMs?: number
}

function sshArgs(ap: WifiAccessPoint, command: string[], timeoutMs: number): string[] {
  const host = ap.sshHost?.trim()
  const username = ap.sshUsername?.trim()
  if (!host || !username) {
    throw new Error('SSH host/username not configured for this WiFi source')
  }

  const connectTimeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000))
  const args = [
    '-p',
    String(ap.sshPort || 22),
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${connectTimeoutSec}`,
  ]

  // Stored as a generic secret; callers may provide a key path.
  if (ap.sshPrivateKey) {
    args.push('-i', ap.sshPrivateKey)
  }

  args.push(`${username}@${host}`, ...command)
  return args
}

async function runProcess(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<WifiCommandResult> {
  return new Promise((resolve) => {
    const start = performance.now()
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        ok: false,
        stdout,
        stderr: stderr || error.message,
        latencyMs: Math.round(performance.now() - start),
        error: error.message,
      })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const latencyMs = Math.round(performance.now() - start)
      if (timedOut) {
        resolve({
          ok: false,
          stdout,
          stderr,
          latencyMs,
          error: `timeout after ${timeoutMs}ms`,
        })
        return
      }
      if (code !== 0) {
        resolve({
          ok: false,
          stdout,
          stderr,
          latencyMs,
          error: stderr.trim() || `exit code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`,
        })
        return
      }
      resolve({ ok: true, stdout, stderr, latencyMs })
    })
  })
}

/**
 * Executes one SSH command against an AP source.
 */
export async function runSshCommand(
  ap: WifiAccessPoint,
  command: string[],
  options: RunSshOptions = {}
): Promise<WifiCommandResult> {
  const timeoutMs = options.timeoutMs ?? 8000
  return runProcess('ssh', sshArgs(ap, command, timeoutMs), timeoutMs)
}

/**
 * Persists an audit row for every attempted two-way command.
 */
export async function recordWifiCommandAudit(input: {
  apId: number
  executedByUserId: number | null
  mac?: string | null
  command: string
  params?: Record<string, unknown> | null
  result: WifiCommandResult
}): Promise<void> {
  await db
    .insertQuery()
    .table('wifi_command_audits')
    .insert({
      ap_id: input.apId,
      executed_by_user_id: input.executedByUserId,
      mac: input.mac ?? null,
      command: input.command,
      params: input.params ? JSON.stringify(input.params) : null,
      status: input.result.ok ? 'ok' : 'failed',
      stdout: input.result.stdout || null,
      stderr: input.result.stderr || input.result.error || null,
      executed_at: DateTime.utc().toFormat('yyyy-MM-dd HH:mm:ss'),
    })
}
