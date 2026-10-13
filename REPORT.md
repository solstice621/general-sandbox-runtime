# Sandbox Runtime 0.2.0：TypeScript 重构与验收报告

**交付日期：2026 年 10 月 14 日（Asia/Shanghai）。** Runtime 核心、共享 Policy、两平台后端、Linux supervisor 和 DSH Bash 适配器已全面迁移到 TypeScript。交付不依赖 Go，不通过 TypeScript 包装旧 Go 可执行文件。严格编译输出 JavaScript、类型声明及 source map；生产运行时仅依赖 Node 和系统隔离工具。

最终冻结版本在 **macOS ARM64、Linux ARM64 各通过 52 项沙盒验收和 25 项 DSH 接入测试，全部 0 失败**。两平台各 1 项 SIGKILL 限制观察单独记录，未计入通过数。安装与 API 见 [README](README.md)，原设计与历史版本见 [Page](https://chatgpt.com/space/page_78d476a52cec8191ab2ba9efe6b17d55)。

## 1. 重构后的实现

| 层次 | TypeScript 源码 | 行为 |
|---|---|---|
| Policy | [policy.ts](src/policy.ts) | 64 KiB 严格 JSON、重复键/未知字段/Unicode 检查；不可变规则、逻辑及物理路径、bigint 文件身份、symlink/hardlink 审计、安全环境 |
| 公共 API | [index.ts](src/index.ts)、[runner.ts](src/runner.ts) | 导出 run/check/communicationGrant 和共享类型；进程与临时资源所有权、期限、取消、信号、父进程检查及结果保留 |
| CLI | [cli.ts](src/cli.ts)、[launcher](scripts/launcher.sh) | 原生 argv、bounded policy-file、运行选项；最小 shell bootstrap 在 Node 初始化前验证调用方 FD 并清除 Node 启动注入 |
| macOS | [macos.ts](src/backends/macos.ts) | 系统 Seatbelt，默认拒绝、明确写入/禁读、祖先保护、IP 与宿主 Unix socket 分离 |
| Linux | [linux.ts](src/backends/linux.ts)、[seccomp.ts](src/backends/seccomp.ts)、[supervisor](src/backends/linux-supervisor.ts) | Bubblewrap 只读挂载与私有 namespace、零 capabilities、no_new_privs、seccomp；namespace 内的 TypeScript supervisor 管理 payload 进程组 |
| DSH | [Provider](adapters/dsh/provider.ts)、[插件](adapters/dsh/plugin.ts) | 复用共享 Policy 与类型，保留私有 Bash 作用域、可信 spawn、不可重用调用身份、审批及后台任务语义 |

构建要求 Node **>=24.19.0**；本次两平台均使用 24.19.0，TypeScript 5.9.3 与 @types/node 24.0.0 由 lockfile 固定。核心没有第三方 npm 运行时依赖。DSH 的上游包由可信 Harness 提供；测试固定 commit `d743267388641bc76f17c45ce8b4c231aed1d32c`，其声明与真实上游源码接口独立核对。

Go 源码、平台二进制及旧验收结果已从当前 0.2.0 目录移除。0.1.0 原始交付包作为独立历史基线保留。Python 黑盒测试、策略示例生成器和 C 系统调用探针仍是测试/使用辅助材料，不是 Runtime 或隔离 helper。

## 2. 迁移中实际验证的边界

**FD 行为不能直接照搬 Go。** Node 初始化会创建自己的 pipe/socket，因此只在 JS 中 fstat 一个数字，可能把原本不存在的调用方 FD 当成已授权通道。最小 launcher 在任何外部命令、管道或命令替换之前，用 shell builtins 验证全部显式源 FD；CLI 核对来源快照，库 API 使用不可伪造的授权对象，并在 spawn 前重新核对活跃 FD 的身份。库不会关闭调用方拥有的源句柄。

Linux 的独立对照试验进一步证实：普通 Node `stdio: ignore` 空位会泄漏 FD 25 和 192。当前 Runner 在最终事件循环让出之后重新枚举 FD，把所有未授权目标显式映射到自身打开的 `/dev/null`；授权通道及后端私有通道使用独立明确映射，过大 FD 编号拒绝执行。实测既阻止两项泄漏，也保留 target 64 通信和父进程句柄。macOS、Linux 各有 **60 项 launcher 测试**，包括低/高 FD、注入变量、原始身份、外部 npm symlink 和命令参数边界；这些测试与 52 项沙盒验收分别计数。[启动层证据](evidence/typescript/bootstrap/fd-probes/review-notes.txt)

Linux 使用私有 socketpair 向 namespace 内的 TypeScript supervisor 发出信号。配置 FD 在 payload 启动前关闭，supervisor 在 spawn 后关闭其应用 FD 副本；payload 不获得控制通道。Bubblewrap 的 PID namespace 和 die-with-parent 承担最终回收，因此不再需要 Go 版本的 pidfd 进程组 helper 或 Linux 6.9 版本门槛。仍须在目标内核验证必需能力，不能由这一变化推断任意旧内核都受支持。

已取消、已过期或父进程身份变化的调用在启动 OS launcher 前停止。launcher 已启动后的取消属于有界终止；没有 ready/start 握手保证缓冲的取消消息必定早于 payload exec。`supervisor-started` 仅表示 OS launcher 已启动，stderr/退出码也不是可信的未执行证明，DSH 不据此自动重试。

## 3. 最终测试及实际环境

| 验证 | macOS ARM64 | Linux ARM64 |
|---|---|---|
| 实际环境 | macOS 26.6.2 / Darwin 25.6.0，UID 501，系统 sandbox-exec | Linux 6.10.14-linuxkit，Debian 12 / glibc 2.36，UID 1000，Bubblewrap 0.8.0 |
| 严格 TypeScript 编译 | 通过 | 通过 |
| node:test 单元及真实 API 测试 | 72 通过，0 失败，1 平台不适用 | 71 通过，0 失败，2 平台不适用 |
| 其中真实 API 相关测试 | 全部 9 项执行通过 | 全部 9 项执行通过 |
| CLI 黑盒沙盒验收 | 52 通过，0 失败 | 52 通过，0 失败 |
| 实际 DSH 工具链 | 25 通过，0 失败，0 跳过 | 25 通过，0 失败，0 跳过 |
| 最小 launcher 独立验证 | 60 通过 | 60 通过 |
| Linux supervisor 额外验证 | 不适用 | 3 通过，0 失败 |
| SIGKILL 限制观察 | 1 项，payload 可继续、temp 残留 | 1 项，namespace 工作负载停止、temp 残留 |

node:test 共 73 个测试/子测试。真实 API 的 4 项隔离测试均通过 `SANDBOX_RUNTIME_INTEGRATION=1` 启用；其余 5 项验证调用前取消、父身份、期限、参数与授权工厂。Linux 的平台及大小写不敏感文件系统用例未适用，macOS 对应的大小写别名用例实际执行。额外 6 项 Python 单元测试检查验收身份工具会拒绝文件变化、增删、symlink 和错误部署根。

沙盒验收保留原有文件、网络、Unix socket、进程、环境和失败语义检查，并增加实际 Node/JS 进程身份、NODE_OPTIONS preload、原始 FD 不存在及完整 JS 安装保护。它检查文件字节、监听器收到的数据、实际进程和清理结果，不能仅靠错误文本或生成的 profile 通过。Linux 的额外测试确认 setsid 后代在 leader 退出和期限升级后停止；探查 supervisor 的 proc FD 未取得未授权秘密句柄，不能重开控制 socket，SIGUSR1 未激活 inspector。

DSH 使用真实上游 ToolRuntime、Bash/job 工具、审批服务、策略解析/投影和 subprocess。覆盖两种受限模式、单次批准、拒绝、会话权限变化、等待转后台、job_output/job_kill、期限、取消、并发与伪造 stderr。Agent 身份、会话存储及目录服务为内存 fixture，审批回答通过真实服务模拟；没有运行 LLM、人机审批 UI，也没有认证上游原生 cgroup helper。

Linux fixture 在 Docker Desktop 原生 ARM64 VM 内执行，不含宿主 bind mount。外层放宽的 Docker 初始化权限用于允许嵌套 Bubblewrap；payload 本身 capabilities 为零，并启用 no_new_privs 和 seccomp。完整环境、缺 helper/namespace 失败及资源清理记录以原始证据为准。更早 macOS、Intel macOS、Linux amd64 和其他 Linux 发行版没有实机认证。

## 4. 解释型部署的证据绑定

单个 launcher 的 SHA 不能标识 TypeScript 运行时。验收记录 **launcher、实际 Node 可执行文件、package.json 及 dist 下所有文件**，在执行前后比较同一集合；验收及 benchmark 均从宿主进程信息独立确认实际 Node 可执行路径和准确的 `dist/src/cli.js` 参数，不依赖 Runner 自报版本。

| 已测试部署 | 54 个文件的 SHA-256 集合摘要 |
|---|---|
| macOS | `dbb692dcf25909305dadf059043f98f1fbbfc15954fc442af23156ab6c97ee01` |
| Linux | `fe1cf367542f17ca10a7d8a7495c25e4b3fa5725d5f5613afa7a1d403dd1d60d` |

两平台 Node 二进制及 launcher 的绝对 Node 路径不同，集合摘要因此不同。该集合明确包含已部署的测试/构建输出；系统内核、系统隔离工具及动态库另作为可信环境前提，不宣称这些摘要是整台机器的完整度量、代码签名或第三方认证。

交付的 `bin/sandbox-runner` 是本机已测 launcher；在其他宿主执行 `npm ci && npm run build`，生成该宿主的 Node 路径。编译产物与 `.d.ts` 已附带，安装后应针对实际新部署重新验收。发行包文件清单和摘要见 [release-manifest.json](release-manifest.json) 与 [SHA256SUMS](SHA256SUMS)。

## 5. 启动性能与兼容性

每组预热 5 次、测量 30 次 `/usr/bin/true`，计入 CLI、策略检查、OS 初始化及清理。

| 平台 | 直接执行中位数 | 沙盒中位数 | 中位数增加 | 沙盒 p95 |
|---|---:|---:|---:|---:|
| macOS ARM64 | 3.439 ms | 65.141 ms | 61.702 ms | 70.592 ms |
| Linux ARM64 | 0.283 ms | 45.103 ms | 44.820 ms | 46.611 ms |

同一工作会话保存的 Go 0.1.0 历史样本中，沙盒中位数分别为 20.375 ms 和约 3.264 ms。这不是配对控制实验，但明确表明当前 TS 方案没有取得启动速度优势。它统一 Runtime/适配器的语言、共享策略和接口类型，代价是 Node 启动及 Linux 第二个 Node supervisor 的成本；没有把该成本归因为已经单独测量过的某个组件。

两平台均通过 Python、SQLite、私有 temp、子进程，以及沙盒内 C 编译和执行。数据为当前机器的温热样本，不是吞吐保证；记录了组合子进程 CPU，未单独测量峰值内存。

## 6. 保留的范围与限制

- **强杀与 macOS 后代：** macOS Runner 被 SIGKILL 后 payload 可继续，自行脱离原进程组的后代也没有无条件回收保证；Linux namespace 工作负载会停止。强杀均可能残留 temp，没有仅凭 PID 自动删除旧目录的 GC。
- **读取和消费者：** host-read 加明确 denyRead，未禁读的文件仍可能读取。仅 DSH Bash 接入经过验收；PTC、持久 PTY、全局 Provider 替换、原生文件工具及其他 MCP 入口不自动受限。
- **可信宿主：** Harness、Node、Runtime、适配器、系统工具/依赖、策略及启动环境必须可信。嵌入方须维持已授权 FD 的所有权直到 spawn；这不抵抗恶意同 UID 宿主的并发篡改、内核漏洞、资源耗尽或多租户攻击。
- **路径：** 只支持现存普通文件和目录；硬链接/路径审计上限 100000 项，无法完成即拒绝。Linux 不支持对系统安装、proc/dev/sys 或加载器配置扩大写权限。
- **网络：** 仅 deny/host，本地 TCP/UDP 与 localhost 解析已测；proxy、凭据注入、命名 Unix socket 授权、公网 DNS 与企业代理行为未认证。
- **结果：** 共享 stderr 和退出码可被 payload 模仿，125 不证明未执行；仅观察到启动器阶段时不能自动重试命令。

这些边界与重构前声明一致，新增 Linux supervisor 行为及 Node FD 差异均有单独证据。交付没有自动修改用户现有 DSH 安装、会话或系统代理设置。

## 7. 原始证据与复现入口

- macOS：[沙盒验收](test-results/typescript/macos-acceptance.json)、[API/单元日志](test-results/typescript/macos-unit.tap)、[benchmark](test-results/typescript/macos-benchmark.json)、[同次强杀观察摘录](test-results/typescript/macos-sigkill-observation.json)。
- Linux：[沙盒验收](evidence/typescript/linux-acceptance.json)、[API/单元日志](evidence/typescript/linux-unit.tap)、[benchmark](evidence/typescript/linux-benchmark.json)、[supervisor 额外验收](evidence/typescript/linux-supervisor-acceptance.json)、[环境](evidence/typescript/linux-environment.json)、[失败即拒绝证据](evidence/typescript/linux-failure-closure.json)。
- DSH：[最终两平台证据](adapters/dsh/test-evidence.json)、[macOS TAP](adapters/dsh/test/final-macos.tap)、[Linux TAP](evidence/typescript/dsh-linux.tap)、[固定上游来源](adapters/dsh/source-lock.json)。
- 启动层：[macOS 60 项](evidence/typescript/bootstrap/fd-probes/template-macos.json)、[Linux 60 项](evidence/typescript/bootstrap/fd-probes/template-linux.json)、[FD 泄漏对照](evidence/typescript/bootstrap/fd-probes/linux-stdio-coverage.json)、[身份工具测试](test-results/typescript/identity-unit.log)。
- 复现：[完整验收说明](tests/README.md)、[Linux fixture](tests/linux/README.md)、[DSH 方法及范围](adapters/dsh/README.md)。
