/**
 * Start and supervise the optional omp auth broker and auth gateway beside one
 * dsh profile.
 *
 * The gateway speaks the Anthropic Messages wire format and performs the
 * provider request itself, so an `llm-pi-ai` route can point at it without
 * carrying any provider credential. Both children belong to this plugin's
 * fiber: disposal aborts the lifetime signal, which makes the subprocess
 * provider terminate each managed range before the profile finishes unloading.
 *
 * @module @deepseek-ai/dsh-experimental-omp-gateway
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import z from '@deepseek-ai/schemastery'

export const name = 'experimental-omp-gateway'
export const inject = ['subprocess']

/** Process, readiness, and credential-publication configuration. */
export interface Config {
  /** Whether this profile starts and owns the children; false mounts nothing. */
  enabled?: boolean
  /** Executable providing the `auth-broker` and `auth-gateway` subcommands. */
  ompCommand?: string
  /** Working directory for both children; defaults to the host process cwd. */
  cwd?: string
  /** Start `omp auth-broker serve` before the gateway. */
  startBroker?: boolean
  /** Broker URL the gateway dials. */
  brokerUrl?: string
  /** Bind address for the broker listener. */
  brokerBind?: string
  /** Bind address for the gateway listener. */
  gatewayBind?: string
  /** Base URL that `llm-pi-ai` routes use; must match {@link gatewayBind}. */
  gatewayUrl?: string
  /** omp config root holding the token files; defaults to `PI_CONFIG_DIR` or `~/.omp`. */
  configDir?: string
  /** Credential reference that receives the gateway bearer when {@link publishToken} is on. */
  tokenRef?: string
  /** Store the gateway bearer in the dsh credential store after readiness. */
  publishToken?: boolean
  /** Run `omp auth-gateway check --strict` before serving. */
  preflight?: 'strict' | 'off'
  /** Reuse a healthy gateway already listening at {@link gatewayUrl}. */
  reuseExisting?: boolean
  /** One health-polling interval. */
  pollIntervalMs?: number
  /** Deadline for each readiness probe. */
  readinessTimeoutMs?: number
  /** Deadline for the one-shot preflight check. */
  checkTimeoutMs?: number
  /** Termination grace handed to the subprocess provider. */
  graceMs?: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  ompCommand: z.string().default('omp'),
  cwd: z.string(),
  startBroker: z.boolean().default(true),
  brokerUrl: z.string().default('http://127.0.0.1:8765'),
  brokerBind: z.string().default('127.0.0.1:8765'),
  gatewayBind: z.string().default('127.0.0.1:4000'),
  gatewayUrl: z.string().default('http://127.0.0.1:4000'),
  configDir: z.string(),
  tokenRef: z.string().default('OMP_GATEWAY_TOKEN'),
  publishToken: z.boolean().default(true),
  preflight: z.union(['strict', 'off']).default('strict'),
  reuseExisting: z.boolean().default(true),
  pollIntervalMs: z.natural().default(150),
  readinessTimeoutMs: z.natural().default(15_000),
  checkTimeoutMs: z.natural().default(120_000),
  graceMs: z.natural().default(5_000),
})

/** Ambient entries an omp child needs to find its config root, credentials, and binaries. */
const BASE_ENVIRONMENT = [
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PATH',
] as const

/**
 * Build the explicit child environment. The subprocess provider scrubs ambient
 * credentials, so omp's own configuration variables are forwarded deliberately.
 * @param extra - per-child entries overriding the ambient base.
 * @returns the environment for one spawned command.
 */
function childEnvironment(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  for (const key of BASE_ENVIRONMENT) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && (key.startsWith('PI_') || key.startsWith('OMP_'))) environment[key] = value
  }
  return { ...environment, ...extra }
}

/**
 * Wait while honoring the owning signal.
 * @param milliseconds - delay length.
 * @param signal - cancellation of the wait.
 * @returns completion, or rejection with the signal reason.
 */
function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  const rejectWithReason = (reject: (reason: Error) => void): void => {
    reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
  }
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)))
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const onAbort = (): void => { clearTimeout(timer); rejectWithReason(reject) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, milliseconds)
  signal.addEventListener('abort', onAbort, { once: true })
  return promise
}

/**
 * Poll one unauthenticated health endpoint until it answers 2xx.
 * @param url - health endpoint.
 * @param signal - owning lifetime.
 * @param timeoutMs - deadline for the whole poll.
 * @param intervalMs - delay between attempts.
 * @returns completion once healthy.
 * @throws when the deadline expires.
 */
async function waitForHealth(
  url: string, signal: AbortSignal, timeoutMs: number, intervalMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    signal.throwIfAborted()
    try {
      const response = await fetch(url, { signal })
      await response.body?.cancel()
      if (response.ok) return
    } catch (error: unknown) {
      if (signal.aborted) throw error
    }
    if (Date.now() >= deadline) throw new Error(`omp-gateway: ${url} did not become healthy within ${timeoutMs}ms`)
    await delay(intervalMs, signal)
  }
}

/**
 * Check one health endpoint once.
 * @param url - health endpoint.
 * @param signal - owning lifetime.
 * @returns whether the endpoint answered 2xx.
 */
async function isHealthy(url: string, signal: AbortSignal): Promise<boolean> {
  try {
    const response = await fetch(url, { signal })
    await response.body?.cancel()
    return response.ok
  } catch (error: unknown) {
    if (signal.aborted) throw error
    return false
  }
}

/** One spawned child and the command that identifies it in diagnostics. */
interface Child {
  readonly command: string
  readonly handle: SubprocessHandle
}

/** Spawn timing and disposition for one child. */
interface SpawnOptions {
  /** Environment entries merged onto the explicit base. */
  readonly environment?: NodeJS.ProcessEnv
  /** Pass diagnostics through to the host streams instead of collecting them. */
  readonly inherit?: boolean
  /** Per-child cancellation; defaults to the plugin lifetime. */
  readonly signal?: AbortSignal
  /** One-shot commands exit by design, so their exit is not an unexpected failure. */
  readonly oneShot?: boolean
}

/**
 * Start the broker and gateway for this profile and own them for the plugin
 * lifetime. Readiness is awaited before `apply` resolves, so a request that
 * reaches `llm-pi-ai` after boot finds a listening gateway.
 * @param ctx - host context with the subprocess service.
 * @param config - validated process, readiness, and credential configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.enabled === false) return

  const lifetime = new AbortController()
  const children: Child[] = []
  const readinessTimeoutMs = config.readinessTimeoutMs ?? 15_000
  const pollIntervalMs = config.pollIntervalMs ?? 150
  const graceMs = config.graceMs ?? 5_000
  const gatewayUrl = config.gatewayUrl ?? 'http://127.0.0.1:4000'
  const brokerUrl = config.brokerUrl ?? 'http://127.0.0.1:8765'

  // Register teardown before spawning so a later failure still aborts children.
  ctx.effect(() => () => {
    lifetime.abort(new Error('omp-gateway: profile unloaded'))
    return Promise.allSettled(children.map(child => child.handle.done)).then(() => undefined)
  }, 'omp-gateway: terminate children')

  const spawn = (argv: readonly string[], options: SpawnOptions = {}): SubprocessHandle => {
    const signal = options.signal ?? lifetime.signal
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: config.cwd ?? process.cwd(),
      env: childEnvironment(options.environment ?? {}),
      graceMs,
      signal,
      stdio: options.inherit === true
        ? { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' }
        : { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
    })
    const command = argv.slice(1).join(' ')
    children.push({ command, handle })
    if (options.oneShot !== true) {
      handle.done.then((outcome: SubprocessOutcome) => {
        if (lifetime.signal.aborted) return
        ctx.logger.error('omp-gateway: child exited unexpectedly (%s): %o', command, outcome)
        lifetime.abort(new Error(`omp-gateway: ${command} exited`))
      }, (error: unknown) => {
        if (lifetime.signal.aborted) return
        ctx.logger.error('omp-gateway: child failed (%s): %o', command, error)
        lifetime.abort(error)
      })
    }
    return handle
  }

  try {
    const executable = await ctx.subprocess.resolveExecutable(config.ompCommand ?? 'omp', undefined, lifetime.signal)

    if ((config.preflight ?? 'strict') === 'strict') {
      const checkSignal = AbortSignal.any([
        lifetime.signal,
        AbortSignal.timeout(config.checkTimeoutMs ?? 120_000),
      ])
      const check = spawn([executable, 'auth-gateway', 'check', '--strict'], {
        signal: checkSignal, oneShot: true,
      })
      let outcome: SubprocessOutcome
      try {
        outcome = await check.done
      } catch (error: unknown) {
        throw new Error('omp-gateway: auth-gateway check --strict could not run', { cause: error })
      }
      if (outcome.exitCode !== 0) {
        const stderr = check.collected.stderr?.readFrom(0).text.trim() ?? ''
        throw new Error(
          `omp-gateway: auth-gateway check --strict exited ${String(outcome.exitCode)}`
          + (stderr === '' ? '' : `: ${stderr}`),
        )
      }
    }

    if ((config.reuseExisting ?? true) && await isHealthy(`${gatewayUrl}/healthz`, lifetime.signal)) {
      ctx.logger.info('omp-gateway: reusing the gateway already listening at %s', gatewayUrl)
      return
    }

    if (config.startBroker !== false) {
      spawn([executable, 'auth-broker', 'serve', `--bind=${config.brokerBind ?? '127.0.0.1:8765'}`], { inherit: true })
      await waitForHealth(`${brokerUrl}/v1/healthz`, lifetime.signal, readinessTimeoutMs, pollIntervalMs)
    }

    spawn([executable, 'auth-gateway', 'serve', `--bind=${config.gatewayBind ?? '127.0.0.1:4000'}`], {
      inherit: true,
      environment: { OMP_AUTH_BROKER_URL: brokerUrl },
    })
    await waitForHealth(`${gatewayUrl}/healthz`, lifetime.signal, readinessTimeoutMs, pollIntervalMs)

    if (config.publishToken !== false) {
      const credentials = ctx.get('credentials')
      if (credentials === undefined) {
        ctx.logger.warn('omp-gateway: no credentials service; the gateway bearer was not stored')
      } else {
        const configDir = config.configDir ?? process.env.PI_CONFIG_DIR ?? join(homedir(), '.omp')
        const token = (await readFile(join(configDir, 'auth-gateway.token'), 'utf8')).trim()
        if (token === '') throw new Error(`omp-gateway: ${join(configDir, 'auth-gateway.token')} is empty`)
        await credentials.set(credentialRef(config.tokenRef ?? 'OMP_GATEWAY_TOKEN'), token)
      }
    }

    ctx.logger.info('omp-gateway: ready at %s', gatewayUrl)
  } catch (error: unknown) {
    lifetime.abort(error)
    throw error
  }
}
