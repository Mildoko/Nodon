---
id: ADR-R1-03
version: r1-prep.2
date: 2026-11-02
status: 推荐合同已冻结供采用；未实现、未测量
task: R1-P02
---

# 有界页面投影、事件游标与真实输入回执

推荐Node唯一持有Document、CommandQueue、run不可变启动快照、权限和AI状态。UI只持有有界只读DTO、尚未提交的文字/预览意图、来源栈与焦点，不从视图计算或回写计分、碰撞、可玩性和权限。本文列接口的计划语义，不宣称现有源码具有这些名称；不改现有Runtime/证据合同、不写执行代码或产品测试。

## 1. 命令边界与一致观察

CommandQueue处理每项命令必须同步完成当次校验与内存转移，**不得await** Repository、KDF、Keychain、模型、计时器或网络。外部工作在队列外准备；结果带原`serverEpoch/workspaceGeneration/profileId/projectId/baseRevision/writerEpoch/requestId/grantEpoch`回队列重新比较后应用。先核幂等原回执，重放不暂停新run、不消耗第二次额度或产生第二份副本。Repository异步回执只能确认其实际committedRevision；revision n完成时当前n+1仍dirty。最终数据库保存/恢复事务的细节由ADR-R1-01拥有，不用一个UI成功回调冒充持久。

Node先验证Node发行的profile/workspace会话，再按ID读取；不得依据URL或客户端profile字段选择任意目录/工作区。事件、比较、候选详情同样核归属。跨profile拒绝存在性泄漏，不用“只读”绕开资料边界。

## 2. thin snapshot与背压

冻结目标：一个未压缩UTF-8 JSON thin snapshot最多**64KiB**；单客户端活动订阅默认**10Hz**、最高**20Hz**。这是待验上限，非已测吞吐。每连接最多一个发送中的快照及一个最新待发槽；慢客户端合并中间投影，绝不排无限待发列表。版本/撤权转移以Node状态为准，UI断流则禁相关写/发送，重连先获取新全量thin snapshot，不能把旧缓存重放为命令。安全通知优先，不能用20Hz节流延后主机撤权。

每份至少含`projectionVersion,serverEpoch,workspaceGeneration,projectionSeq,emittedAt,contextId`；相关作品含`projectId,revision,semanticHash,persistedRevision,saveState,playability,writerState/writerEpoch`；相关run含`runId,generation,runSource,sourceVersion,runtimeVersion,buildId,runtimeArtifactHash,status,tick,score,remainingTicks,currentPositions,limitedCounters,oldestCursor,newestCursor,droppedWallTicks`；AI只给生命周期、request/candidate身份、适用验证摘要与独立availability。输入聚合回执只保最新序号及有限统计。

禁止持续传`frames/history/allInputs/allEvents`、AI请求全文/完整试跑轨迹、全部快照正文或无界诊断。按当前页面选择所需片段；完整文档仅在明确打开/编辑/导出边界按结构预算校验，不能为满足64KiB截断作品。候选差异、版本比较、事件详项按需分页，不塞进持续投影；单DTO过大明确`projection_too_large`并停受影响视图/写操作，保Node有效草稿及正式导出退路，不静默丢实体或伪造成功。原始机器证据由Node证据层按既有合同保留，UI优化不能删除其必需字段；留存/导出能力仍待实施验收。

与P03性能合同统一冻结：创作活动订阅总量最多3个，另有成人订阅1个；第4个创作连接只给静态只读的容量告知，不发行写权、不排队等待为活动订阅，不能形成无限连接/发送队列。每连接1在途＋1最新pending。事件单页未压缩JSON上限128KiB，UI仅保留最多3页/300项，翻页淘汰旧显示页并保游标/截断提示；不能在前端拼出无限历史。超页预算明确错误，不静默截断见证。20Hz是UI传输上限，Runtime tick仍用其唯一合同，不随浏览器刷新或显示舍入改变；全部数值是实施前目标，实际结果仍未执行。

## 3. 事件游标

计划读取形状：`readEvents({runId,afterCursor,limit})`，默认limit50、合法1–100、最大100；Node每run保留1000个事件的环，afterCursor表示**排除该项之后**。游标由Node发行，opaque并绑定`serverEpoch/runId/generation/sequence`，不当写权限、DOM身份或因果关系。初读省略afterCursor，返回当前保留环最早一页；响应包含`runId/generation/evidenceVersion/events/nextCursor/oldestCursor/newestCursor/hasMore/retainedCount/truncation`，每event保原eventId/tick/sequence。

- 正常页：严格sequence升序，无重复；nextCursor指最后实际返回项。空页保请求游标（初始空run给begin cursor），hasMore=false，不虚构eventId。
- 请求游标早于保留范围：返回`cursor_expired`、当前oldest/newest、已知丢失sequence范围/数量和`requiresExplicitRestart=true`；不自动把首屏替换成完整链。UI说明“较早事件已省略”，用户明确从oldest重读；缺cause保缺失标记。
- 游标属于别的run/generation/serverEpoch：`cursor_mismatch`，不猜当前run、不返回别run事件。未来游标拒绝`cursor_ahead`。未知/已释放run返回`run_unavailable`，不创建空run或拿当前作补历史。
- `readEventDetail(runId,eventId)`仅从同一授权run证据读取；事件已截断返回`event_evicted`与可用范围。Node仍有完整封存证据时，须通过明确的历史证据接口/包身份读取，不能把环缓存字段冒充全run已完整保留。

环范围与读取在一个同步观察点捕获，页取出后视为不可变；不会一边翻页一边用当前作品重算旧event。cursor有效性只代表可定位，不代表原内容许可、AI发送范围或当前写权。

## 4. run来源与证据@3

每run绑定不可变`sourceVersion={projectId,revision,semanticHash,snapshotId?,contentRef}`、runtime/build/artifact及`runSource=current|comparison|peer|preset|candidate_machine_test|historical_reference`，S05另有playPurpose。比较左右侧分别固定contentRef和runId；旧run一律只读，不把当前rules/当前位置拼入旧run。编辑语义改变使旧run invalidated，标题/说明/意图/纯主题只改变作品revision，旧paused run仍保启动外观与版本；ended/fault/invalidated绝不因返回/恢复/undo/同hash复活。新run丢弃旧generation回调。

正式`collect-chase-evidence@3` DTO保`observationPhase`、actualValues、规则/实体引用及逐对ContactWitness：`entityIds,startPositions,endPositions,closestTickFraction,minCenterDistance,contactThreshold,endpointCenterDistance,contacted`。事件positions仅是该phase采样端点；after_move不能标成接触点。S03分列“步内最近距离/时刻”“步末距离”；步末距离大于阈值也可发生段内扫掠接触。多守卫逐份见证，primaryGuardId只影响默认展示。显示数值舍入不回流判据。

旧@2/K03独立版本只读分支只显示原字段/未知，不能补造Witness；真实@3缺必需见证标缺证/损坏并阻断对应解释结论。诊断保attemptedTick/lastCommittedTick，不把故障尝试伪造成已提交玩法事件。同tick达标/caught并列，不能凭显示顺序发明cause。AI读与S03相同版本最小证据DTO，只有明确选中的必要事件链/原run参数/缺失标记可发送，不发整场历史。

## 5. 输入发送、接收与生效

浏览器输入意图携带`inputSeq,clientSentAt,runId,generation,direction,viewFocusEpoch`；Node入口记录`serverReceivedAt`，队列执行时记录`effectiveTick/disposition=applied|rejected|cleared`及原因、latestAppliedInputSeq。客户端时间仅诊断，跨时钟不直接相减为网络延迟；end-to-end用客户端单调时钟关联回执，host queue delay用Node单调时钟计算。旧序号/重复/旧run/非running/失焦拒绝，禁止先显示已生效再等实际回执。

BrowserInputAdapter只在可玩视图聚焦且running时发送；输入框、模态和管理页不驱动游戏。blur/visibility hidden/disconnect发clearKeys并暂停；Node连接存活/焦点门状态在下一步前清键，不能依赖最后一个keyup必达。返回/重连/焦点恢复不自动继续、不追算后台墙钟时间。首个非零input缺失与droppedWallTicks分别观测；未知原因不归咎单一层、不写已修复。

## 6. 非执行验收与来源

后续T01/T07/T08/T16核：64KiB/20Hz与慢消费背压，1000事件溢出/50默认/100最大/错run/未来游标，双比较run不混当前作，合法完整扫掠接触但步末距超阈值，多守卫逐份Witness，旧@2未知，首输入发送→接收→effectiveTick、失焦/断线清键。实际结果全部`not_executed`；P03性能数值以主性能合同一致版本为准，变更须更新引用而不悄改分母。

来源为本vault 09目录P01 §2/S03/S05/S07、P03 §1/4/5、工程任务R1-P02/T07/T08/T16；06目录R00/C13；08目录`05_自家产品完整性与可行性核对_2026-11-02.md`（首输入未收、droppedWallTicks与延迟尚未分因）。正式@3依据09 P03所指定的R0 runtime/motion合同，本轮未运行产品或生成新run证据。
