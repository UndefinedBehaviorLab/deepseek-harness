import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import type { Config as GatewayConfig } from '../src/index.ts'

interface FakeChild {
  readonly argv: readonly string[]
  readonly spec: SubprocessSpawnSpec
  stderrText: string
  readonly handle: SubprocessHandle
  resolve(outcome: SubprocessOutcome): void
}

class FakeSubprocess {
  readonly spawns: FakeChild[] = []
  exitCode = 0
  stderr = ''

  async resolveExecutable(): Promise<string> {
    return '/fake/omp'
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const { promise, resolve } = Promise.withResolvers<SubprocessOutcome>()
    const child: FakeChild = {
      argv: spec.argv,
      spec,
      stderrText: '',
      handle: {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: {
          stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: child.stderrText, nextOffset: child.stderrText.length, lossy: false }) },
        },
        done: promise,
        terminate: () => { resolve({ exitCode: 0, signal: 'SIGTERM' }) },
        waitForExit: async () => true,
      },
      resolve,
    }
    spec.signal?.addEventListener('abort', () => { resolve({ exitCode: 0, signal: 'SIGTERM' }) }, { once: true })
    this.spawns.push(child)
    if (spec.argv[1] === 'auth-gateway' && spec.argv[2] === 'check') {
      child.stderrText = this.stderr
      resolve({ exitCode: this.exitCode, signal: null })
    }
    return child.handle
  }
}

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface MountOptions {
  subprocess?: FakeSubprocess
  credentials?: { set: (ref: string, value: string) => Promise<void> }
}

async function mount(config: GatewayConfig = {}, options: MountOptions = {}): Promise<{ ctx: Context; subprocess: FakeSubprocess }> {
  const subprocess = options.subprocess ?? new FakeSubprocess()
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('subprocess', subprocess as never)
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials as never)
  await ctx.plugin({ name, inject, Config, apply }, Object.assign({ publishToken: false }, config))
  return { ctx, subprocess }
}

function healthyFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })))
}

describe('omp gateway supervision', () => {
  it('runs the preflight, starts the broker then the gateway, and terminates both on disposal', async () => {
    healthyFetch()
    const { ctx, subprocess } = await mount({ reuseExisting: false })

    expect(subprocess.spawns.map(child => child.argv.join(' '))).toEqual([
      '/fake/omp auth-gateway check --strict',
      '/fake/omp auth-broker serve --bind=127.0.0.1:8765',
      '/fake/omp auth-gateway serve --bind=127.0.0.1:4000',
    ])
    const gateway = subprocess.spawns[2]!
    expect(gateway.spec.env?.OMP_AUTH_BROKER_URL).toBe('http://127.0.0.1:8765')
    expect(gateway.spec.graceMs).toBe(5000)

    await ctx.fiber.dispose()
    expect(gateway.spec.signal?.aborted).toBe(true)
  })

  it('fails loudly with the preflight diagnostic and aborts spawned work', async () => {
    healthyFetch()
    const subprocess = new FakeSubprocess()
    subprocess.exitCode = 2
    subprocess.stderr = 'no credentials'

    await expect(mount({}, { subprocess })).rejects.toThrow(/check --strict exited 2: no credentials/)
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0]!.spec.signal?.aborted).toBe(true)
  })

  it('reuses a healthy gateway without spawning', async () => {
    healthyFetch()
    const { subprocess } = await mount({ preflight: 'off' })
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('does not start the broker when configured off', async () => {
    healthyFetch()
    const { subprocess } = await mount({ preflight: 'off', startBroker: false, reuseExisting: false })
    expect(subprocess.spawns.map(child => child.argv[2])).toEqual(['serve'])
    expect(subprocess.spawns[0]!.argv[1]).toBe('auth-gateway')
  })

  it('fails when the gateway never becomes healthy and aborts the child', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    const subprocess = new FakeSubprocess()

    await expect(mount({
      preflight: 'off', readinessTimeoutMs: 50, pollIntervalMs: 1,
    }, { subprocess })).rejects.toThrow(/did not become healthy within 50ms/)
    expect(subprocess.spawns[0]!.spec.signal?.aborted).toBe(true)
  })

  it('stores the gateway bearer through the credential service', async () => {
    healthyFetch()
    const root = await mkdtemp(join(tmpdir(), 'dsh-omp-gateway-'))
    try {
      await writeFile(join(root, 'auth-gateway.token'), 'gateway-token\n')
      const set = vi.fn(async () => {})
      const { subprocess } = await mount({
        preflight: 'off', reuseExisting: false, startBroker: false, configDir: root, publishToken: true, tokenRef: 'OMP_GATEWAY_TOKEN',
      }, { credentials: { set } })

      expect(subprocess.spawns).toHaveLength(1)
      expect(set).toHaveBeenCalledWith('OMP_GATEWAY_TOKEN', 'gateway-token')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
