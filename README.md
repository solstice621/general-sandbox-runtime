# 通用 Sandbox Runtime 0.2

命令沙盒的核心、策略校验、平台后端、Linux supervisor 和 DSH Bash 适配器均以 TypeScript 实现。严格 NodeNext 构建生成 JavaScript、类型声明和绑定本机 Node 绝对路径的 CLI launcher。核心没有第三方 npm 运行时依赖，不需要 Go 或自定义原生 helper，也不运行常驻服务。

Runtime 面向可信 Harness 启动不可信命令的场景，提供 macOS Seatbelt 和 Linux Bubblewrap/seccomp 后端。所需隔离能力不可用时拒绝执行。平台验证状态、实际测试环境和运行时文件集合摘要见 [实施与验收报告](REPORT.md)；旧版 Go 的验收结果不能证明本次 TypeScript 实现正确。这不是虚拟机、多租户或资源配额系统。

## 构建和运行

需要 Node.js **24.19.0 或更高版本**。TypeScript 和 Node 类型声明仅用于构建，版本锁定在 `package-lock.json`。

- macOS 使用系统 `/usr/bin/sandbox-exec`。
- Linux 使用可执行、非 setuid、非 group/world writable 的 `/usr/bin/bwrap`，以及可用的 user、PID、mount、IPC namespace 和 seccomp；`network: deny` 还需要 network namespace。Linux 在独立 PID namespace 内运行 TypeScript supervisor，通过私有控制通道转发终止请求并管理 payload。支持的最低内核版本须由目标环境验收确定。

在可信环境和目录中执行：

```sh
npm ci
npm run build
./bin/sandbox-runner version
```

构建产物位于 `dist/`，`bin/sandbox-runner` 是最小 shell bootstrap。构建脚本将当次 `process.execPath` 的真实绝对路径写入 launcher；不能把某台机器生成的 launcher 当作另一台机器的通用入口。每个目标宿主必须使用其受信 Node 重新构建或生成匹配的 launcher。运行时需要保留完整部署目录，包括 `dist/`、根包元数据和 launcher；核心执行不依赖 `node_modules/` 中的构建工具。DSH 插件另由宿主提供固定版本的 DSH 包。

为一个**已存在**的工作目录生成完整策略。策略通过 argv 传输，不要在其中放凭据。生成器不读取工作区隐式配置。

```sh
RUNNER="$(pwd -P)/bin/sandbox-runner"
POLICY="$(python3 scripts/policy.py --workspace /absolute/project --mode workspace-write)"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" \
  "$RUNNER" check --policy-json "$POLICY"
/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME" \
  "$RUNNER" run --policy-json "$POLICY" --timeout 30s -- \
  /bin/bash -c 'printf "hello\n" > /absolute/project/result.txt'
```

调用方必须在启动 launcher **之前**清理加载器、解释器和 shell 注入变量，并使用可信绝对路径。launcher 在 Node 分配内部 FD 前，用 shell builtins 检查显式授予的原始通信句柄，并清除 `NODE_OPTIONS`、`NODE_PATH`；这不能替代调用方对整个启动环境的清理。CLI 的 `--grant-fd` 必须经过生成的 launcher，不能直接调用 `node dist/src/cli.js` 绕过原始句柄快照。DSH 插件在实际 spawn 边界实施安全启动。

`check` 只预检策略、依赖和静态能力。`run` 重新校验，并由操作系统建立边界；预检通过不证明后续 payload 已启动。调用方设置 cwd，cwd 不增加写权限。没有 `--timeout` 时没有 Runner 执行期限，前台等待期限、后台任务和审批仍由 Harness 管理。

`--timeout`、`--grace` 和 `--diagnostics` 仅在 `run` 中生效；`check` 会校验这些选项，但不执行期限或生命周期日志逻辑。timeout 包含 CLI 首次策略读取与检查，最大 2147483647 ms（约 24.86 天）；`--grace 0` 使用默认 500 ms，允许范围为 0–5 s。

## 策略和命令接口

`check|run` 必须且只能指定 `--policy-json` 或 `--policy-file`。文件方式只接受普通文件，原始 JSON 上限 64 KiB。字段、重复键、null、Unicode、路径、取值及能力均严格校验。详见 [JSON Schema](schema/policy.schema.json) 和 [运行时额外检查](schema/README.md)。

| 能力 | 当前行为 |
|---|---|
| 读取 | `read: host`，再应用 `denyRead`；未禁读的宿主文件仍可能读取 |
| 写入 | 默认禁止；仅放行 `allowWrite` 的字面绝对路径；`denyRead` 和 `denyWrite` 优先 |
| 路径 | 只支持存在的普通文件和目录树；拒绝缺失保护路径、可变 symlink 链、已发现硬链接及超过 100000 项的审计 |
| 临时文件 | `none` 或本次唯一的 `private` 目录；允许授权 `/tmp` 下的具体子目录，禁止把整个 Runtime 临时存储父目录作为可写根 |
| 网络 | `deny` 阻断直接 IP 网络；`host` 允许普通 TCP/UDP/IP。两种模式都拒绝宿主 Unix socket 端点 |
| IPC | 支持必要的匿名 Unix stream/seqpacket socketpair；Linux 拒绝可重新连接宿主端点的 datagram socketpair |
| 环境 | 固定系统 PATH；仅选择并校验 HOME、LANG、LC_ALL、TZ、TERM；临时目录变量由 Runner 设置 |
| 通信 FD | 重复 `--grant-fd 源编号:目标编号`；源 3–1024、目标 3–64，只接受 pipe/socket，授予 payload 及后代；其余继承句柄不传给 payload |
| 标准流 | 原生 argv、stdin/stdout 字节保留；stderr 可混合命令输出与诊断，不能作为可信启动状态 |
| 退出 | 保留普通退出码；未处理信号编码为 `128 + signal`；显式执行期限为 124；CLI 校验或准备错误为 125。OS 启动器建立隔离失败也可能返回其他非零值，退出码不能证明 payload 是否运行 |
| 终止 | 默认 500 ms grace 后升级；保留命令自行处理信号后的实际退出码；清理失败不覆盖命令结果 |
| 诊断 | `--diagnostics` 在 stderr 输出 run ID、后端、策略摘要、阶段和结果，不记录 argv、环境值或命令输出 |

如果工具安装在 `/opt/homebrew/bin` 等系统 PATH 之外，请在 payload 中使用其绝对路径。代理、凭据注入、任意启动环境覆盖、命名 Unix socket 授权和 proxy 模式不在当前核心接口内。

标准流和显式通信 FD 本身就是能力。调用方不能把敏感的已打开文件、目录或网络句柄作为标准流交入沙盒，再期待路径规则撤销该能力。`--grant-fd` 的继承范围固定为后代。

## TypeScript API

根包导出 `run`、`check`、`communicationGrant` 和共享策略类型；`@local/sandbox-runtime/policy` 导出完整策略 API，`@local/sandbox-runtime/dsh` 与 `@local/sandbox-runtime/dsh/provider` 提供 DSH 接入模块。构建后的入口及 `.d.ts` 路径由根 `package.json` 的 `exports` 声明。

直接引用受信部署也可以使用：

```ts
import { parsePolicy, run } from '/trusted/sandbox-runtime/dist/src/index.js'

const policy = parsePolicy(policyJSON)
const result = await run({ policy, argv: ['/usr/bin/true'] })
```

`run` 是异步 API。策略校验返回独立、深度冻结的对象，路径的原始逻辑别名保留为非枚举属性，不进入 wire JSON。嵌入者通过 `communicationGrant(source, target)` 创建通信授权，并负责将源句柄保持打开直到 spawn；不能用自行构造的普通对象代替授权。整个嵌入宿主及 Node 启动环境必须可信，导入模块之后才清理环境无法撤销已经运行的 preload。

## DSH 接入

使用 [Bash 适配器说明](adapters/dsh/README.md) 中的可信 composition 插件。适配器针对固定 DSH commit `d743267388641bc76f17c45ce8b4c231aed1d32c`，限定私有 Bash 服务作用域，保留已有审批、任务、输出和 subprocess 所有权。不要全局替换共享 Provider。

`read-only` 和 `workspace-write` 映射到共享策略模型；`danger-full-access` 沿用 DSH 的明确旁路。`runnerFailureRules` 始终为空，payload 伪造 fatal stderr 不会被误报成“命令没有执行”。PTC、PTY、持久终端、原生文件工具和其他 MCP 工具不会因安装这个 Bash 插件自动受限。实际消费者验证记录与 CLI 验收记录分开保存。

本交付不修改用户当前安装的 DSH，也不默认启用现有会话中的插件。

## 验证和升级

```sh
npm run typecheck
SANDBOX_RUNTIME_INTEGRATION=1 npm test
NODE_EXECUTABLE="$(node -p 'require("node:fs").realpathSync(process.execPath)')"
python3 tests/acceptance.py --runner "$PWD/bin/sandbox-runner" \
  --node "$NODE_EXECUTABLE" --report test-results/ts-local-acceptance.json
python3 tests/benchmark.py --runner "$PWD/bin/sandbox-runner" \
  --node "$NODE_EXECUTABLE" --report test-results/ts-local-benchmark.json
```

`--node` 必须指向生成 launcher 时选定的同一规范绝对路径。`SANDBOX_RUNTIME_INTEGRATION=1` 启用真实隔离下的 API 生命周期及 FD 测试；省略时这 4 项会明确跳过。最终两平台验证均启用了它。验收还需要 Python 3 和宿主 C 编译器；C 代码只用于低层系统调用测试，不是运行时 helper。`make build`、`make test`、`make typecheck`、`make acceptance` 和 `make benchmark` 提供相同流程；可用 `NODE=/absolute/path/to/node` 指定该宿主的受信 Node。

完整验收必须在实际允许创建隔离边界的宿主上执行。禁止嵌套 Seatbelt/user namespace 时应报告失败，不能改成跳过。测试创建自己的临时 fixture 和 loopback 服务，验证文件、网络、FD 和进程结果。测试说明见 [tests/README.md](tests/README.md)，Linux 环境方法见 [tests/linux/README.md](tests/linux/README.md)。

安装时保护完整 Runtime 部署树、Node、系统 helper、适配器、Harness 及其依赖。它们必须处于命令不可修改的受信边界内，并限制 group/world 写权限。升级时先在独立目录构建，验证**launcher、Node、编译产物与包元数据的完整文件集合**，完成该版本的目标环境验收，再等旧任务退出后切换绝对路径。只比较 launcher 的摘要不足以标识解释型运行时，也不能把旧版本结果改名用于新构建。

macOS 使用进程组管理终止；自行脱离该组的后代不在回收保证内。直接 SIGKILL Runner 无法执行清理，macOS 子进程和临时目录可能继续存在。Linux 依靠私有 PID namespace 与 Bubblewrap 父进程死亡处理结束受管理进程，强杀仍可能留下临时资源。每次执行使用随机 run ID 和 ownership 记录，不提供仅凭 PID 删除旧目录的 GC；回收残留前必须确认没有进程使用它。
