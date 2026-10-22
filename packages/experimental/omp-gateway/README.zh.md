---
description: "在当前 dsh profile 旁启动并托管 omp auth broker 与 auth gateway。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-omp-gateway

[English](README.md) | 中文

## 摘要

挂载本插件后，当前 profile 会启动 [oh-my-pi](https://github.com/can1357/oh-my-pi) 的 auth broker 与 auth gateway 子进程，等待它们健康，并在 profile 卸载时一并终止。gateway 使用 Anthropic Messages 线协议，因此可以让 `llm-pi-ai` 路由指向它，由 omp 使用自己的凭据和请求指纹完成 provider 请求；dsh 该路由不持有任何 provider 凭据。

本插件为本仓库私有。它要求系统中已有 `omp` 可执行文件，不会安装或升级它。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 profile 中挂载 `subprocess` 与本插件，并让 `llm-pi-ai` provider 指向 gateway：

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

默认开启 `publishToken`：就绪后插件读取 `<configDir>/auth-gateway.token`，写入凭据服务的 `tokenRef`；`llm-pi-ai` 路由按请求解析该引用。

配置字段、默认值与校验见生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-omp-gateway)。

### 启动顺序

1. 一次性运行 `omp auth-gateway check --strict` 预检；非零退出会让插件启动失败，并带上该命令 stderr 的尾部。
2. 如果 `gatewayUrl` 上已有健康 gateway，则直接复用，本 profile 不启动、也不拥有任何进程。
3. 否则启动 `omp auth-broker serve`（`startBroker` 为 false 时跳过），等待 `/v1/healthz`。
4. 启动 `omp auth-gateway serve` 并注入 `OMP_AUTH_BROKER_URL`，等待 `/healthz`。
5. `publishToken` 开启时读取并发布 gateway bearer。

就绪等待发生在插件启动阶段，因此启动完成后到达 `llm-pi-ai` 的请求一定能连上 gateway。预检失败、健康检查超时，或等待期间子进程退出，都会让插件启动失败，不会静默降级。

<a id="understand-the-implementation"></a>
## 实现说明

插件通过 [`subprocess`](../../subprocess/subprocess/README.zh.md) seam 持有两个常驻子进程。spawn 时传入插件生命周期的 `AbortSignal`；dispose 时 abort 该信号，subprocess provider 按配置的 grace 终止托管范围，随后插件等待两个 `done` promise。profile 卸载、CLI 关闭与 Desktop Host 关闭都走同一条路径，因为它们都会 dispose profile 的 context。

子进程继承经过清洗的环境，外加显式基础项（`HOME`、平台配置目录、`PATH`）以及宿主进程中的全部 `PI_*` / `OMP_*`。gateway 额外收到 `OMP_AUTH_BROKER_URL`；broker token 由 omp 从自己的配置目录或环境变量中发现。

就绪之后的意外退出会记录子进程命令与退出结果，并 abort 生命周期，从而终止另一个子进程，避免留下“gateway 已死、broker 仍在”的状态。

<a id="model-experience"></a>
## 模型体验

无，因为本插件只启动回环进程并存储 bearer，不注册工具、请求字段或模型上下文。

#### KV Cache 影响

无直接影响；路由发出的模型请求保持不变。

## 已知限制与后续工作

- **外部可执行文件**：`omp` 必须已安装，且版本要与 `llm-pi-ai` 路由期望的模型和线协议行为一致；插件不安装、锁定或升级它。
- **预检成本**：`check --strict` 会探测凭据，可能消耗 provider 额度；可设置 `preflight: off` 跳过。
- **进程树限制**：正常 dispose 会终止托管范围；宿主进程被 `SIGKILL` 时，在无法观测逃逸子进程的平台上可能留下子进程。
- **端口共享**：两个 profile 同时设置 `reuseExisting: false` 且绑定同一地址时，后启动的 `serve` 会失败；请保留默认复用行为或分配不同端口。
- **凭据范围**：发布后的 bearer 对任何能读取凭据存储的本地进程都有效；除非修改 `gatewayBind`，gateway 只监听回环地址。

<a id="dev-note"></a>
### 开发说明

gateway 的入站请求与 dsh 的 provider 请求是两跳：dsh 把 Anthropic Messages 请求发给本地 gateway，gateway 再用 omp 的凭据与请求指纹发往 provider。因此失败会先表现为 gateway 的 HTTP 错误，而不是 `llm-pi-ai` 的传输错误；`llm-retry` 只能看到 gateway 的状态码。
