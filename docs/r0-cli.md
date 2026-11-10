# R0 CLI 与运行证据

CLI 只在 `/Users/dmy/Projects/Nodon-R0` 使用冻结的 Node 24.21.0 和已编译模块运行。机器目录输入属于 `machine_test / catalog_machine / automation_test`，不代替浏览器键盘、真人或 AI 验证。

```sh
cd /Users/dmy/Projects/Nodon-R0
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run build
node dist/src/host/cli.js run --fixture terminal-conflict --input terminal-conflict
node dist/src/host/cli.js verify --case R0-RT-07
node dist/src/host/cli.js replay --run /Users/dmy/Projects/Nodon-R0/evidence/r0/a29f25dcd468/04_runs/3b8dfa42-88ea-4198-806f-7310baa2d93c
node dist/src/host/cli.js audit --run /Users/dmy/Projects/Nodon-R0/evidence/r0/a29f25dcd468/04_runs/3b8dfa42-88ea-4198-806f-7310baa2d93c
```

上列路径为构建 `a29f25dcd468` 的实际 R0-RT-07 caught 包。其审计通过；实际回放包为 `1df75a97-dee1-42ee-9ce6-e07119289c5f`，比较 `equal=true / sameBuild=true`。后续代码构建改变时保留这些历史包，并使用新执行输出的 runPath。另有同构建 scene-b 的 1800 tick 包 `f663f950-3e99-4927-83fd-a9dcbd2b5b79`，其 1,083,095 字节 tick-frames 文件已通过审计，覆盖超过 1 MiB 的证据读取分支。

`run` 只接受 `verification/fixtures` 与 `verification/inputs` 内现存的受控 ID，不接受路径或 URL。`verify` 当前只执行 R0-RT-07；三个变体各自从合法初态真实推进 900 tick，分别见证 caught、timeout、win。

证据唯一目录为 `evidence/r0/<build-id>/04_runs/<runId>/`。完整初态、实际消费输入、逐 tick 状态、已提交事件、诊断、控制操作、最终状态、断言和 @3 RunEnvelope 分文件保存；manifest 绑定每份文件的字节长度及 SHA-256，并绑定对应真实 build manifest。导出重新计算当前构建；启动后构建改变会拒绝导出。文件包不可覆盖。

玩法事件只保留最近 1000 条，明确记录累计数量、丢弃数量、保留序号与最后丢弃 tick。观察入口返回原事件及缺失前因，绝不补写事实。独立 EventRing 合成探针仅是 unit 来源，不能导出成实际 RunSession。

回放先核对旧包全部指纹，使用初态、消费输入和生命周期控制生成新 runId，source 为 replay，并记录 originalInputSource 和旧包引用。比较只正规化运行/事件身份及事件引用，保留版本、初态、revision、semanticHash、构建、实际值、每 tick 状态和终局。相同 artifact 与环境可重建审计；旧 artifact 或环境只读指纹历史审计。当前构建不同的回放明确标记 historicalBuild，不能声称 same-build reproducible。初态或构建/文件指纹缺失即失败，不以截图补证。

RunSession 的暂停不推进 tick；仅 paused 可 resume。玩法编辑使旧 run invalidated，撤销也不复活；文本/主题编辑暂停 running，继续时仍使用启动时的 revision 与外观。Node R0Host 的 Store 命令与运行操作共用唯一 CommandQueue；连接、时钟守护与 AI 绑定由后续任务接入。
