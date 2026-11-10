# R0 T05 Node候选实现补充

此说明只落实冻结D07–D09，不修改T00合同、模型或费用。本轮入口固定`source: controlled_fixture`，没有provider请求，不是实际AI输出。

`CandidateManager(host, authority, {currentBuild, yieldSlice?})`要求同一CommandQueue、同一Store writer/session/project。`prepareControlled({requestId,operations})`校验UUID和严格1–3七op DTO，对当前完整副本执行顺序expectedValue，沿用domain最终空间/结构/适用可玩性校验及C13摘要。静态主题可用于不可玩草稿；包含玩法op必须使整份候选可玩。

`trial(candidateId)`使用同路径RunSession/Runtime冻结候选，CC-SMOKE-01真实最多180tick，每15tick离开队列让出执行，合法终局早停，最后结果还需重新入队检查。`yieldSlice`仅为可控调度/结果释放屏障，不能注入passed或Runtime产物。trial拥有独立runId、baseRevision和候选semanticHash，不替换Host正式run或history；无奖励/追逐时明确未覆盖，不声明路线、难度或15秒timeout成立。纯主题只有当前构建静态记录，trialId/run均null。

`confirm(candidateId, commandId?)`在同一队列中派生完整D09私有绑定，重读权限/epoch/writer/项目/revision/semanticHash/buildHash/runtimeArtifactHash/contractHash/trustedConfigHashes/environment，再执行同操作并复算hash，核对专属真实trial或纯主题例外。Node内部WeakMap对象身份许可不可由JSON伪造，一次消费后Store只做一次revision与一层undo提交。相同commandId回原回执；新commandId二次确认拒绝。HTTP层只传candidateId和commandId，不接受operations、candidateState、passed或许可作为确认依据。

`cancel`、`revoke`、authority关闭/角色scope或writer变化、Host任意revision变化终止所有相关未提交候选，并清操作及可应用副本。重开不会复活。Trial证据保留原生状态与实际run；中断中的trial记blocked，不能进入proposed。确认与关闭同queue线性化，先提交则保留作品，先撤销则零写入。

`CandidateSnapshot`是可序列化公开视图，不含RequestSnapshot、sessionId、writerToken或许可；`canConfirm/canTrial`由Node当前权限/版本/build即时派生，浏览器不得自行计算资格。候选只在完整静态校验+真实passed或纯主题例外后proposed。

共享Host新增`preview`（同一个Store完整副本，不消耗allocator/receipt/undo）、`inspect`（Node计数、可玩性、总分、预算）、`stepClock(readHeld,allowed)`（队列内重读最新输入与lossGate，终局不再tick）、`onRevision`。原Host.input/startRun及T03证据接口保留；浏览器启动选machine_browser_input/automation_test，人工标签仍需真实成人实操。

执行验证由唯一实际根`/Users/dmy/Projects/Nodon-R0`完成；此说明与暂存源码本身不表示测试、浏览器或人工验收通过。

冻结RT16负向验证通过Node构造参数`verification`运行：无executor保留not_run；tickCap0或未达180且仍运行则blocked；expectedTargetScore99使真实loaded断言失败；runtimeOptions的显式faultInjection走真实Runtime故障事务。HTTP不接受这些测试设置；它们不能注入成功记录或跳过试跑。

Node证据API：`Host.exportCurrentRun(options)`与`CandidateManager.exportTrial(id, options)`固定经过实际根及实际build核验；前者导出04_runs真包，后者另写06_candidates不可覆盖proof，关联candidateHash、原生trial、run包manifestHash。失败/取消保留原真实历史可以导出，不能重标新build或passed；纯主题只有static proof及null runPath。相同真实快照、assertions和引用的重试可复用已审计包；不同内容拒绝覆盖。浏览器不传文件路径，建议先暂停正式run再导出；运行中的trial须等完成或先取消。

只读候选视图提供`eligibilityError`解释当前build/权限/revision过期；读快照不修改候选状态。串行确认/试跑check发现build变化时将候选stale并清ops，继续拒绝写入。

D04会话CommandBus的commandId跨手动/候选共用Node私有kind命名空间。不同kind复用同UUID一律E_IDEMPOTENCY_CONFLICT且零写入；同kind仍沿各自载荷fingerprint/缓存回执。手动只有严格信封/会话/writer/project已被Store接收并确实缓存才登记（含E_NO_CHANGE等已接收失败），malformed/未授权不抢占；preview不登记、不消耗ID。候选按已有合法UUID确认接收与失败缓存语义登记。
