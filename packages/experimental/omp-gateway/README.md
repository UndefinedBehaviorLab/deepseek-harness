---
description: "Start and supervise the omp auth broker and auth gateway beside a dsh profile."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-omp-gateway

English | [中文](README.zh.md)

## Summary

Mount this plugin to run the [oh-my-pi](https://github.com/can1357/oh-my-pi) auth broker and auth gateway as children of the current profile, wait for them to become healthy, and terminate both when the profile unloads. The gateway speaks the Anthropic Messages wire format, so an `llm-pi-ai` route can point at it and let omp perform the provider request with its own credentials and wire identity. No dsh code carries a provider credential for that route.

The plugin is private to this repository. It requires an `omp` executable; it never installs or updates one.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount `subprocess` and this plugin in the profile, then point a `llm-pi-ai` provider at the gateway URL:

```yaml
- id: omp-gateway
  name: '@deepseek-ai/dsh-experimental-omp-gateway'
  config:
    gatewayUrl: http://127.0.0.1:4000

- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      anthropic-gateway:
        displayName: Anthropic (omp gateway)
        api: anthropic-messages
        baseURL: http://127.0.0.1:4000
        apiKeyEnv: OMP_GATEWAY_TOKEN
        models:
          - id: anthropic/claude-sonnet-4-5
            contextWindow: 200000
            maxTokens: 64000
```

With `publishToken` on (the default), the plugin reads `<configDir>/auth-gateway.token` after readiness and stores it in the credential service under `tokenRef`. The `llm-pi-ai` route resolves that reference per request.

Configuration fields, defaults, and validation are listed in the generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-omp-gateway).

### Startup order

1. `omp auth-gateway check --strict` runs once as a preflight. A non-zero exit fails plugin startup with the check's stderr tail.
2. A healthy gateway already listening at `gatewayUrl` is reused; this profile spawns nothing and owns nothing.
3. Otherwise `omp auth-broker serve` starts (unless `startBroker` is false) and its `/v1/healthz` is awaited.
4. `omp auth-gateway serve` starts with `OMP_AUTH_BROKER_URL` and its `/healthz` is awaited.
5. The gateway bearer is read and published when `publishToken` is on.

Readiness is awaited inside plugin startup, so a request that reaches `llm-pi-ai` after boot finds a listening gateway. A preflight failure, an unhealthy endpoint, or a child that exits during the wait fails plugin startup; nothing is silently degraded.

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin owns two long-lived children through the [`subprocess`](../../subprocess/subprocess/README.md) seam. It spawns them with the plugin's lifetime `AbortSignal`; disposal aborts that signal, which makes the subprocess provider terminate each managed range with its configured grace, and the plugin then awaits both `done` promises. The same mechanism covers profile unload, CLI shutdown, and Desktop Host shutdown, because all of them dispose the profile's context.

Children inherit a scrubbed environment plus an explicit base (`HOME`, platform config directories, `PATH`) and every `PI_*` / `OMP_*` entry from the host process. The gateway receives `OMP_AUTH_BROKER_URL`; the broker token is discovered by omp from its own config directory or environment.

An unexpected exit after readiness logs the child's command and outcome and aborts the lifetime, so the surviving child is terminated instead of being left beside a dead gateway.

<a id="model-experience"></a>
## Model Experience

None, as this plugin only starts loopback processes and stores a bearer; it registers no tools, request fields, or model context.

#### KV Cache effect

No direct effect; the model request the route sends is unchanged.

## Known Limitations and Deferred Work

- **External executable** — `omp` must be installed and its version must match the models and wire behavior the `llm-pi-ai` route expects. The plugin does not install, pin, or update it.
- **Preflight cost** — `check --strict` probes credentials and may consume provider quota before serving. Set `preflight: off` to skip it.
- **Process-tree limits** — normal disposal terminates the managed range. A host process killed with `SIGKILL` can leave children on hosts where the subprocess provider cannot observe escaped descendants.
- **Port sharing** — two profiles that both set `reuseExisting: false` and the same bind address fail on the second `serve`. Keep the default reuse behavior or assign distinct ports.
- **Credential scope** — the published bearer authenticates any local process that can read the credential store; the gateway listener is loopback-only unless `gatewayBind` says otherwise.

<a id="dev-note"></a>
### Dev Note

The gateway's inbound request and the dsh provider request are separate hops: dsh sends an Anthropic Messages request to the loopback gateway, and the gateway sends the provider request with omp's credentials and wire identity. Failures therefore surface as gateway HTTP errors rather than as `llm-pi-ai` transport errors, and `llm-retry` sees only the gateway's status.
