---
contractVersion: nodon-r0-runtime-contract@1
baseline: review.4-r0-20261028
date: 2026-10-28
status: T00工程冻结候选；待主实施者核准本页D01–D12及环境manifest后供T01编码
---

# R0 Runtime 工程合同

本合同只约束获准唯一产品根 `/Users/dmy/Projects/Nodon-R0`。当前文件的 `/tmp/nodon-r0-stage/` 路径仅为待同步文档暂存，不是第二实现、运行或证据根。Obsidian中的设计样例保持设计身份。没有代码、模型输出、运行结果或人工评价可从本合同推定为通过。

## 1 来源及优先级

来源根V=`/Users/dmy/Obsidian/ChandlerLee_Vault_Internal/AI游戏创作平台-Nodon`。以下均为V下确切相对路径；编号是本合同引用，不是新增任务号。

- S00：`07_R0最小真实闭环开发计划_评审稿/P00_R0范围技术决策与执行总表.md`，§2–4唯一DAG/T00–T11。
- S01：同目录`P01_真实运行与证据验证计划.md`，§3、§3.1、T01–T08、§5–7。
- S04：同目录`P04_技术决策工程补充与来源核查.md`，ADR-R0-01–06。
- S05：同目录`P05_冻结任务提案与证据记录模板.md`，§1–6。
- C03：`06_v3.0平台与AI详细设计_评审稿/产品策划/C03_玩法域风险取舍与数值规则案.md`，§2–4及review.4。
- C07：同产品策划目录`C07_试玩运行状态与终局规格案.md`，§1–7及review.3。
- C08：同目录`C08_真实运行观察与诊断案.md`，§2、§6及多守卫合同。
- C09：同目录`C09_作品生命周期撤销与版本比较案.md`，§1–2及review.3。
- C10：同目录`C10_作品格式文件交接与兼容案.md`，§1、§6及review.3/4。
- C13：同目录`C13_可关闭AI助手与变更协议案.md`，请求/提交/成人控制及review.2–4。
- J01：`06_v3.0平台与AI详细设计_评审稿/config/entity_budget_policy.json`。
- J02：同config目录`rule_registry.json`。
- J03：同目录`candidate_trial_policy.json`（当前@2，history中的@1不解锁）。
- J04：同目录`semantic_projection_example.json`。
- J05：同目录`ud02/risk.nodon.json`；J06：`ud02/garden.nodon.json`。
- J07：同目录`ud02/two_guard_evidence_example.json`；J08：`ai_proposal_example.json`；J09：`README.md`。

2026-10-28用户已批准07计划并授权依赖顺序编码；模型/费用到T06另确认。本页以S04精化06未规定的工程行为，不回写历史样例。冲突优先级：该次用户决定→已确认07→06 review.4→本页明确D项；实现不得默选旧03图DSL或旧原型helper。主实施者已核实本机Node24.21.0，路径`/opt/homebrew/opt/node@24/bin/node`；工具链锁定npm11.19.0、TypeScript5.9.3、Ajv8.20.0、@types/node24.19.2，采用tsc编译，不引入esbuild或Vite。实际依赖闭包/SQLite精确版本由主实施者在环境及构建manifest锁定，不能由版本声明推定依赖已兼容。缺环境指纹不能出具实际执行证据。

## 2 固定版本与文档形状

固定：formatVersion=`3.0-review.3`；runtimeVersion=`collect-chase@1`；catalogVersion=`workshop-core@1`；ruleRegistryVersion=`collect-chase-rules@1`；entityBudgetPolicyVersion=`entity-budget@1`；trialPolicyVersion=`collect-chase-candidate-trial@2`；evidenceVersion=`collect-chase-evidence@3`；工程合同=`nodon-r0-runtime-contract@1`。行为或registry改变须新Runtime映射，不覆盖旧@1。[C10/J01–03]

T01的内存`Document`恰含`formatVersion,runtimeVersion,catalogVersion,project`。`project`恰含`projectId,revision,title,instructions,authorNote,designIntent,sourceProject,scene,rules,presentation,semanticHash`。项目身份/版本/摘要由Node生成或重算，不接受客户端自报覆盖。R0从锁定fixture提取该子集；外部`.nodon.json`导入/导出、`exportedAt`和`snapshots`不是该输入API，禁止把此DTO叫完整文件阅读器。[S01§7/C10]

- `projectId`：非空ASCII字符串，D01限制1–96，匹配`[A-Za-z0-9][A-Za-z0-9._:-]*`；R0新项目用Node生成UUID，fixture可保留其受控ID。`revision`：非负安全整数，从0开始，只由成功改变内容的业务命令递增；到安全整数上限拒绝写入。
- `title`：1–40 UTF-16单元；手动输入完全空串在命令边界转“未命名作品”，其他超限拒绝。`instructions`：0–200；`authorNote`：0–120；`designIntent`：null或0–120。除空标题特例外不trim、不截断、不执行HTML。作者文本不入玩法摘要。[C10/C13]
- `sourceProject`：R0固定null。保留字段，不实施来源图/导入映射；fixture必须为null，不以删字段改写源文件。[S01§7，D01]
- `scene`恰含`worldId:"rect_960_540",width:960,height:540,entities:Entity[]`。
- `Entity`恰含`id,kind,x,y`。`kind`只为`player|guard|normal|high`；id为上述ASCII非空规则，文档内唯一。x/y为有限安全整数，x∈[20,940]、y∈[20,520]，均为10的倍数。半径由kind派生，不入实体JSON。
- 数量：player恰1；guard 0–2；normal 0–12；high 0–3；合计≤18。全部实体两两初始中心距平方≥(半径A＋半径B＋4)²，含恰等合法。玩家半径12、守卫14、两奖励10。世界/玩家速度/半径不可编辑。[C03/J01]
- `rules`恰含`goal:{targetScore}`,`rewards:{normalValue,highValue}`,`guards:{speed,detectRadius}`,`timer:{enabled,limit}`。targetScore整数1–99；normalValue整数1–3；highValue整数2–9且>normalValue；speed整数20–180且步10；detectRadius整数60–300且步10；enabled布尔；limit整数15–120且步5，停用仍必须合法并保留。不存在的类别/无守卫仍保留其参数。[C03/J02]
- `presentation`恰含`themeId,playerSkinId`，必须组成同一受控目录配对。D02冻结验证目录第一项`theme_snack/snack_player_01`，第二项`theme_r0_contrast/snack_player_01`；两者共用同一玩家皮肤ID，仅配色改变。第二项是S04-05授权的验证配色扩充，非旧目录正式美术，T04必须明标“验证配色”。主题只改变绘制；不得添加URL/脚本/远程资源。目录内容及两项配对摘要进入构建清单，正式产品扩目录另决策。[J05/J06/S04-05，主实施者2026-10-28统一目录裁决]
- `semanticHash`：`sha256:`加64位小写hex，载入重算。counts/totalScore/ruleId/registry/运行位置/AI元数据不写入Document。

所有外部对象逐层`additionalProperties=false`；不允许undefined、NaN、Infinity、原型对象、函数或自动数值转换。缺失必填、重复JSON键（在解析入口拒绝）、未知版本、未知字段、非法引用均带字段路径拒绝，零写入。JSON解析大小D03限制1MiB；受控批次操作数另限。内部动态坐标为有限IEEE-754双精度，不受编辑整数/网格约束。[C10，D03]

## 3 校验与命令

结构校验返回`{valid:boolean,errors:[{code,path,message}]}`；可试玩校验另返回`{playable:boolean,totalScore,rewardCount,errors}`。totalScore=`normal数量×normalValue＋high数量×highValue`，不缓存可写副本。结构合法但rewardCount=0或targetScore>totalScore是草稿，可手动提交，不能创建run。风险（出生在发现圈、守卫比玩家快、较短时限）只作warning，不自动改值。[C03/S01]

CommandBus统一信封D04：`{commandId,sessionId,writerToken,projectId,expectedRevision,command}`。commandId使用UUID且会话内幂等；同ID同规范化载荷返回原结果，同ID不同载荷`E_IDEMPOTENCY_CONFLICT`。writerToken只由Node当前会话颁发，不是云权限。失败返回`{ok:false,code,errors,currentRevision}`；成功`{ok:true,changed,revision,semanticHash,allocatedEntityId?}`。所有成功改变内容的命令一次revision+1、一个撤销单元；无变化拒绝`E_NO_CHANGE`且无revision/撤销记录。读取/选中/输入/暂停/重来/试跑都不改revision。

手动command联合类型（下列记录不允许额外字段）：

- `{type:"set_text",field:"title"|"instructions"|"authorNote"|"designIntent",value}`，value遵照该字段类型。
- `{type:"set_goal",value:整数}`；`{type:"set_reward_values",value:{normalValue,highValue}}`；`{type:"set_guard_speed",value:整数}`；`{type:"set_detect_radius",value:整数}`；`{type:"set_timer",value:{enabled,limit}}`；`{type:"set_theme",value:Presentation}`。
- `{type:"move_entity",entityId,x,y}`；`{type:"add_entity",kind:"guard"|"normal"|"high",x,y}`；`{type:"copy_entity",entityId,x,y}`；`{type:"remove_entity",entityId}`。复制/删除player拒绝。复制得到与源同kind的新ID；不复制运行已领取状态。没有静默最近空点、自动调目标、自动开计时或自动替换缺失ID。
- `{type:"undo"}`：恢复最近一次改变内容命令的完整before内容但保留projectId、sourceProject与新revision，重新计算摘要；D05 R0只要求一个撤销单元，不实施redo/50步/保存。撤销本身revision+1，不倒退分配器；清空该单元，不能靠重复undo切换。AI整批可一次撤销。[S01§7/C09]

顺序：同队列核对会话/writer/项目/revision→复制不可变内容→在副本执行完整命令/整批→校验最终结构→需要时校验最终可玩性→一次替换Store/递增revision/提交分配器/存撤销→失效通知。任何失败不得改变文档、allocator、撤销、run和当前AI请求；不可复用可变引用。

D06 ID分配：fixture载入时保留全部ID，设单调计数器1；新增/复制ID依序探测`e1,e2,…`至尚未使用和从未发放的ID，确认成功才推进；预览/失败不消耗。发放集合和计数器是Node会话元数据，不入作品/semanticHash。删除/撤销不移除发放记录，不复用旧ID；项目切换有独立allocator。达到安全整数上限阻止新增。没有按当前位置/数组索引重命名。

编辑若semanticHash改变，旧正式run变invalidated（即使旧run原ended/fault也禁止复活）；旧事件保留。仅表现/文本改变时，running先由编辑交互暂停，paused可在启动revision/外观下继续；AI请求均因任一revision变化stale。撤销回同摘要不复活invalidated run。[C07/C09]

## 4 规范化与摘要

`canonicalSHA256(value)`是SHA-256(严格规范化JSON的UTF-8字节)，输出小写hex加`sha256:`前缀。只允许JSON值；对象键递归按UTF-16代码单元字典序比较（本合同结构键/ID均ASCII，禁止localeCompare）；数组顺序保留；对象无空白，字符串遵循JSON转义、不做Unicode NFC/文本改写；契约整数必须先校验安全整数，-0输出0，不舍入非法值。动态运行浮点不放进semantic/candidate投影；artifact字节使用原始SHA-256。[C10/J04/C13]

semanticHash恰为`canonicalSHA256({scene:normalizedScene,rules,runtimeVersion})`，normalizedScene中entities按ASCII id升序且实体字段不增减；不对原文档数组做就地sort。projectId/revision/title/instructions/authorNote/designIntent/sourceProject/presentation/formatVersion/catalogVersion均排除。[C10]

candidateHash恰为`canonicalSHA256({projectId,requestId,baseRevision,baseSemanticHash,runtimeVersion,catalogVersion,ruleRegistryVersion,trialPolicyVersion,operations,candidateState})`；candidateState恰为`{scene,rules,presentation}`；其entities仍ASCII排序；operations保留原顺序，expectedValue也参与摘要。build/authEpoch/输入/试跑状态不加进candidateHash。candidateSemanticHash另对候选scene/rules/runtimeVersion做C10投影。任何操作、主题、基准身份、内容、受信版本变化重新算candidateHash并重跑；仅换输入新建trial，不篡改candidateHash。[C13/J03/S04-04]

T01必须实际复算J04原始canonicalJson与`sha256:7a0710df8324cf21b85d04ba8fa62f03f62feb3c46e95dca31557facd488aaf9`，并新增实际候选黄金向量：键顺序/实体顺序不变摘要；操作数组逆序（仍合法时）改candidateHash；title/theme不改semanticHash而theme改candidateHash；非法小数拒绝。这里引用的是设计期望，不是本次已实测结果。

主实施者冻结受控主初态：`verification/fixtures/scene-a.json`由J05的完整scene/rules/presentation派生，仅目标6→10并同步instructions中的目标，timer.limit45保留；`verification/fixtures/scene-b.json`由J06完整派生（目标4、0守卫、5普通、不计时、limit30）。运行时重算摘要，不能沿用J05目标6摘要。非AI等价变体由主实施者按x→960−x镜像生成，单独fixture指纹及配对协议，不能把镜像静态关系当实际对照结果。[S05§1，主实施者2026-10-28初态裁决]

## 5 AI计划与候选

请求快照D07恰含`projectId,requestId,baseRevision,baseSemanticHash,runtimeVersion,catalogVersion,ruleRegistryVersion,trialPolicyVersion,capabilityVersion,authEpoch,sessionId,writerToken,requestText,selectedEvidenceRefs`，绑定不可变Document；requestText≤300 UTF-16单元。capabilityVersion=`nodon-r0-capabilities@1`。真实发送DTO另做白名单投影，不发送writerToken/sessionId/本地路径/费用秘密/研究表/未主动选择事件。[C13/S05]

模型结果`kind`限`directions|locate|explain|propose|clarify|unsupported`。非propose禁止operations；quantity答复使用只读`kind:"locate",reasonCode:"manual_quantity"`，没有应用入口。D07把C13的answered/manual_quantity映射为请求状态answered＋reasonCode，而不是新增第八写操作。模型的passed/授权文字不可信。完整候选、校验、hash、trial记录由Node派生，不从模型响应直接采信。

AI Operation联合（op字段，值域与手动一致）：

- `set_goal`: `{op,expectedValue:number,value:number}`，匹配目标旧值。
- `set_reward_values`: `{op,expectedValue:{normalValue,highValue},value:{normalValue,highValue}}`，两值联合提交。
- `set_guard_speed` / `set_detect_radius`: `{op,expectedValue:number,value:number}`。
- `set_timer`: `{op,expectedValue:{enabled,limit},value:{enabled,limit}}`，只切开关也明确保留limit。
- `move_entity`: `{op,entityId,expectedValue:{x,y},value:{x,y}}`，稳定ID必须存在，不改绑；kind不可改变。
- `set_theme`: `{op,expectedValue:Presentation,value:Presentation}`，完整合法目录配对。

每批1–3操作；D08允许同字段顺序操作，expectedValue对照“此前操作已应用的副本”而非反复读基准；中间副本只检查该操作字段类型/值域/引用，空间间距/可玩性统一检查最终完整候选，因此合法两物交换不因中间重叠被误拒。任一expectedValue不相等或最终无净变化则整批拒绝。最终静态校验覆盖未改字段。数量写操作/未知op/未知字段拒绝整批。0守卫时两守卫参数操作`E_NO_GUARD`；无奖励时set_reward_values拒绝`E_NO_REWARD`；缺entityId `E_ENTITY_NOT_FOUND`。纯主题对草稿可静态通过，含任何六类玩法op必须最终可玩。[C13 review.2–4/S00-T05]

候选记录包括请求引用、完整有序operations、candidateState、candidateHash、candidateSemanticHash、validation、trialRequirement、trialStatus、trialRef、预测影响、实际覆盖与缺项。未完成校验/试跑为validation_pending或validation_blocked，不冒称可确认proposed。只有玩法passed或纯主题static-valid＋runtime_not_applicable可进入proposed。请求主态ready→pending→answered|unsupported|failed|canceled|proposed，proposed→applied|rejected|stale；任何未提交态均可被关闭/取消终止，不能重开复活。[C13]

## 6 候选真实试跑及确认

TrialRunner使用与正式run相同create/step/registry/事件实现，独立冻结候选文档和runId，无正式run输入/状态引用。候选事件revision=baseRevision，semanticHash=candidateSemanticHash，不伪造正式新版本。输入目录固定CC-SMOKE-01：tick1–30(0,0)，31–90(1,0)，91–150(0,1)，151–180(-1,0)；合法终局立即结束。逐tick实际消费输入单独记录。[J03/C07]

trialStatus只为not_run/running/passed/failed/blocked/runtime_not_applicable。无执行器not_run；不可玩/环境/执行预算blocked；Runtime或断言故障failed；caught/timeout/win可技术passed。passed必须实际run_started、≥1完整tick、候选变更字段加载断言、无fault/预算越限、事件actualValues/版本/phase一致。180tick不足15秒，不声称timeout触发；未领取/未追逐明确未覆盖。纯主题不造run。追加结果主张须同candidateHash另跑受控输入，每run≤7200tick。[C07/J03/S04-04]

确认D09 DTO=`{commandId,sessionId,writerToken,projectId,requestId,baseRevision,baseSemanticHash,candidateHash,authEpoch,trialId}`。authEpoch/baseRevision均为非负安全整数；requestId/commandId为UUID；trialId为Node生成的非空ASCII ID，纯主题无真实run时必须为null，并关联当前构建的静态校验记录。Node重新读取当前候选，不接受客户端operations/candidateState/passed。串行临界段内重查：会话/current writer/current project/current revision/semanticHash；请求未终止；当前成人/发送范围/授权与预算关联有效；authEpoch一致；重新在当前内容副本执行同operations和expectedValue；最终完整结构/适用可玩性；重新算candidateHash；同候选trial为passed或纯主题例外；buildHash/runtimeArtifactHash/合同/受信版本/环境与当前一致。全部成立单次提交revision+1并标applied；否则零写入。重复commandId返回原结果；另commandId重复确认返回`E_ALREADY_APPLIED`，不产生第二revision。试跑和确认不是正式新run，确认后明确start/restart才新run。[S04-01/04/C13]

## 7 唯一事实、授权和发送线性化

唯一Node进程拥有ProjectStore、CommandBus、正式RunSession、TrialRunner、成人/会话/writer/发送范围、authEpoch和费用账本。CLI是同一核心的独立验证会话；同一活跃作品不能被第二CLI进程和面板各自当正式Store。浏览器只保存表单/焦点和只读快照，RAF只绘制；不得算碰撞/分数/终局/确认资格。[S04-01]

手动命令、确认、成人关闭、writer/scope变化、异步结果接收和dispatch准入进入同一FIFO串行队列（排入序号即线性化顺序）。临界段同步，不await模型、试跑、网络或其他异步工作。长试跑分片，片间允许关闭/取消排入，返回结果再复核。文件/SQLite持久准备若异步，准备完成后必须重新入队核对；不得持旧grant直接dispatch。[S04-01]

成人关闭：authEpoch+1，adultEnabled=false，所有未提交请求终止，清operations/requestedOps和确认资格，取消试跑/可取消上游等待；保留已提交作品和历史证据。writer或scope撤销D10同样递增authEpoch并终止受影响请求。重新打开只影响新请求，不复活旧候选。关闭先线性化则后确认拒绝；确认先合法提交则内容保留。[S04-01/C13]

每attempt都必须同队列：复核当前会话/writer/authEpoch/成人/scope/固定endpoint/provider/model/额度→原子持久预留→dispatch交付。dispatch调用同步交付adapter后只在队列外等待promise。适配器若需等待再实际dispatch，必须再次入队、重新复核。不能以预留等于已发送；记录authorizationCheckedAt/dispatchAt/authEpoch/providerRequestId及状态。关闭先则零新dispatch，只释放可证未发送预留；dispatch先则记in_flight，取消/关闭不能保证无费用/字节立即停止。[S04-01]

T06前模型发送硬禁用，provider/model/SDK/准确费率/金额/token上限/条款/凭证均未批准。本页只冻结接口，不配置key。预算账本持久化SQLite（驱动由主实施者锁），并发1，≤38逻辑请求、每逻辑请求初始＋至多1修复、≤76 attempts，SDK隐式重试0；每attempt重新门禁/计账。任一金额/token/请求数上限先到即停。取消/timeout未知仍占在途和预留直到实际对账；重启不清零。P05上界不是已批准消费，C13旧候选并发/频率不覆盖P05本轮并发1。[S05§3/S00-T06]

## 8 RunSession、输入与接口

正式run包含不可变Document、启动presentation、projectId/revision/semanticHash、runId、generation、build绑定和动态状态。动态：`tick:非负整数,positions:Map<EntityId,{x,y}>,collectedIds:Set<RewardId>,score:非负整数,chasingGuardIds:Set<GuardId>,terminal:null|{reason,caught,timeout,goalReached,caughtByEntityIds,primaryGuardId}`。tick0 score0/领取空/追逐空；初始化不推进、不检查伪胜利；真实run_started一次。[C07]

状态idle→validating→running；校验失败回idle保留结构合法草稿且无run_started。running可paused/ended/fault/invalidated；paused只有明确resume回running；ended/fault/invalidated不resume；restart重新校验当前文档并分配新runId。帮助/编辑/观察只暂停running，其他状态不改变。旧connectionId/generation/runId的输入/回调拒绝。[C07/S01]

D11最小回环接口固定`127.0.0.1`：GET `/api/snapshot`只读；POST `/api/command`手动DTO；POST `/api/run` `{action:"start"|"pause"|"resume"|"restart",runId?,generation?}`；POST `/api/input`；POST `/api/heartbeat`；POST `/api/focus`；GET `/api/events?runId=`；POST `/api/ai/request`、`/api/ai/cancel`；POST `/api/candidate/confirm`、`/api/candidate/reject`；POST `/api/adult`。写请求统一校验服务颁发的本机会话header、Origin精确白名单和writer，JSON-only；端口由启动manifest记录。不提供任意文件/URL/Shell/代码接口，不把回环绑定当成人授权。T06前AI/request返回E_AI_NOT_APPROVED且零dispatch。

输入DTO=`{connectionId,generation,runId,sequence,clientSentAt,x,y}`；x/y各∈{-1,0,1}，sequence严格递增，重复/乱序拒绝。键盘Arrow/WASD按轴合并、相反键抵消，Node仍做归一化。Node接收后在下一个尚未开始tick应用；同tick前有多个有效消息，最后序号作为持有方向，直到新输入/清键；记录所有消息的接收/覆盖/实际生效tick及逐tick消费向量。不能把clientSentAt当模拟时间。[S04-01/S01§6，D11]

失焦/transport明确断开在下一逻辑步前暂停并清方向；心跳每250ms，距最后有效心跳≥1000ms守护暂停。暂停期间不推进；重新聚焦/连接仅重取快照，须resume且输入保持零直到新消息。Node单调时钟驱动1/60，最多追赶5步，丢弃其余落后墙钟并记performance_warning；RAF不驱动内核，暂停期间不累积待补时间。client发送/Node接收/生效tick分开记录，异常延迟标环境缺陷。[S04-01/02]

## 9 构建、证据与可复现

D12构建manifest版本=`nodon-r0-build@1`。文件清单使用产品根相对POSIX路径ASCII排序，每项`{path,byteLength,sha256}`；manifest恰含`manifestVersion,sourceRevision,sourceDirty,sourceFiles,lockfileHash,toolchain,contractHash,trustedConfigHashes,fixtureManifestHash,inputCatalogHash,capabilityHash,adapterCatalogHash,runtimeArtifactManifest,runtimeArtifactHash`。buildHash为该对象canonicalSHA256。不要把buildHash本身/生成时间/证据输出放进其自身输入，不要求“当前Git提交包含manifest”造成循环；sourceDirty如实记录。环境另有environmentId及Node/OS/设备/浏览器实际版本；未用浏览器写null。

runtimeArtifactHash冻结为实际tsc编译模块与第三方运行依赖的完整闭包摘要。`runtimeArtifactManifest`恰含`coreModuleFiles,runtimeDependencyPackages,runtimeDependencyFiles`：coreModuleFiles列出实际被Node执行的全部domain/runtime编译`.js`文件；runtimeDependencyPackages由锁文件解析Ajv及全部transitive runtime依赖，逐项记录`{name,version,packageRoot}`并按packageRoot的相对POSIX路径ASCII排序；runtimeDependencyFiles列出这些实际安装包的全部包文件。两份文件清单均使用产品根相对POSIX路径ASCII排序，每项`{path,byteLength,sha256}`，sha256取该文件原始实际字节。runtimeArtifactHash=`canonicalSHA256(runtimeArtifactManifest)`，不将其自身加入摘要输入；TypeScript/@types等开发依赖排除第三方运行闭包，Node内置实现由environment版本绑定。正式host、CLI、TrialRunner必须import同一组确切编译核心模块路径；manifest须与实际加载路径一致。禁止只hash源码、未执行bundle或一份未包含实际传递依赖的名义产物；当前不使用esbuild/Vite/bundle。宿主/adapter源变化仍改buildHash。执行artifact或合同变化即必须重跑候选，旧passed只历史，不因candidateHash相同复用。[S04-04/06；主实施者2026-10-28 D12裁决：保留非循环build绑定，采用实际模块闭包]

唯一证据根`/Users/dmy/Projects/Nodon-R0/evidence/r0/<build-id>/`，目录沿P03的00_manifest…10_decisions；build-id取buildHash前12hex并检测碰撞、manifest保存全hash。所有run统一`04_runs/<runId>/`，候选/主集索引只引用，不另造case根。每run保存不可变initial-document、逐tick实际inputs、已提交events、diagnostics、最终state、assertions、manifest；@3细节见配套ADR。留档不等于作品持久保存。inputSource只为human_keyboard|machine_browser_input|catalog_machine，executionClass另为automation_test|human_operation；回放仍catalog_machine并记originalInputSource，不冒真人。[S01§6/S05§4]

## 10 T00核准项及后续阻塞

D01–D12是06/07缺少直接编码细节时给出的单一冻结默认，不是“实现时任选”。主实施者须在T00记录每项accept或reject＋替代版本；任何替代更改合同/用例指纹后才编码相关层。D02第二验证主题、D05单步撤销、D08整批最终空间校验、D11 HTTP DTO、D12实际tsc模块及第三方运行依赖闭包应特别核对；不向用户重复逐项请求既有设计授权。

T01执行前需要：主实施者核准工程默认；唯一产品根可写；环境/精确依赖锁和source/fixture/hash清单齐；verification/case-manifest及冻结实验顺序由其单写者完成。T06另等模型/费用批准；不阻塞T01–T05。T04服务/浏览器须实际允许，拒绝则UI blocked且CLI可继续。人工语义裁决/作者选择/真实键盘与成熟工具对照由真实成年人填写；Agent回归不补人工结果。任何缺项不得把T00文档编制写成Runtime或R0整体通过。
