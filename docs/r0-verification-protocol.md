---
title: R0验证协议与冻结用例清单
version: nodon-r0-verification-protocol@1
created: 2026-10-28
status: 未执行；待主实施者合并冻结输入与人工角色登记
---

# R0 验证协议

本协议对应已确认07计划的R0-T00，机器清单为 `verification/case-manifest.json`。唯一未来代码根为 `/Users/dmy/Projects/Nodon-R0`；当前 `/tmp/nodon-r0-stage` 只暂存合同文档，不是另一套实现。本文作者只写这两个文件，没有写实现或测试代码、运行Runtime/游戏/浏览器、读取凭证或发送模型请求。

清单32项均为 `not_executed`，`actualResult=null`。数值推导与独立SHA-256黄金向量是事前判准，不能计产品通过。旧38项原型、旧HTML helper、K03及@2合成摘录只作需求/缺陷来源，不能换标签当新R0真实run。

## 1 判定与执行身份

- 结构合法、可试玩、技术冒烟通过、作者确认、实际正式run结果和持久保存是分别记录的事实。
- 用例结果限未执行/通过/失败/阻塞/不适用，另存原生 `trialStatus`：not_run/running/passed/failed/blocked/runtime_not_applicable。阻塞或not_run不因没有成功而从适用分母消失。
- 自动化用 `executionClass=automation_test`；实际人类操作用 `human_operation`。来源只用human_keyboard、machine_browser_input、catalog_machine；候选证据另标machine_test。混合用例拆实际子记录，不用模糊总来源。
- 人类作者选择、主观帮助评价、语义裁决由实际登记成年人完成。用户可作为内部操作者；Agent或另一模型不能扮演真人，也不能伪称independent_non_developer。
- 同一用例的CLI分支通过不能代替真实浏览器/人类/模型分支。任何尚缺分支按实际标缺证或阻塞，不把局部结果提升为整体验证。

## 2 冻结输入与唯一执行约定

机器清单的 `fixtureDefinitions` 与 `inputDefinitions` 给出确切替换路径、完整实体数组及逐tick分段；路径表示后续必须物化的输入，不声称这些fixture文件已由本文作者创建。主实施者在唯一代码根物化、登记来源指纹、合同指纹、fixture/input指纹后，才能使用它们执行。

内存Document只提取源文件的formatVersion/runtimeVersion/catalogVersion/project；exportedAt与snapshots不进入该API。每个分支默认从独立初态重置；不保留上一用例的位置/计时/领取集合/授权或撤销历史。源设计JSON保留原文与历史身份。

- scene-a来自06/config/ud02/risk.nodon.json，目标6→10，instructions明确10分；其余包括timer.limit45不变。基础玩法摘要预期 `sha256:5220575e1db5a82a52fda9b3ff212b44659bb5c6587e34f419c934eb6bfe43f9`。
- scene-b来自06/config/ud02/garden.nodon.json，保留5普通/0守卫/目标4/不计时/limit30。
- 专用边界fixture只替换清单列出的字段；其标题与instructions明确机器见证，不计主体验路线。
- tick0仅建run；首个输入消费在tick1。输入段按顺序连续展开，零向量也保存。合法终局即停，不能为凑180/900继续步进。
- 所有语义摘要对最终scene/rules/runtimeVersion重算；不得沿用变更前自报semanticHash。
- `R0-RT-07-mirror` 为全部实体x→960-x、输入dx取反，y/规则/ID保持，重新生成真实run；不是镜像日志。AI11重复两次各实际重置并建新run。具体模型请求编号与比较顺序由配套 `r0-comparison-protocol.md` 唯一管理，验证用例不增发对照请求。

## 3 事前独立预期

每条用例包含caseId、globalTasks、fixtureRef、精确步骤、independentExpected、evidenceRequired及source。实施可以增加适配器命令映射，但不得结果出来后改成功标准。字符串中的操作简称按runtime合同DTO展开，不作为另一种Schema。

R0-RT-01至18逐一覆盖P01原18场景；HASH/CMD/CAND/EVID/AUTH/REC/UI/AUDIT/COST补充P00/P04边界。完整步骤以机器清单为准，下面保留关键见证的独立推导，方便审阅者不用产品helper自证。

### 完整900tick三判据见证

R0-RT-07的合法实体：玩家p=(20,270)、守卫g1=(90,270)、普通n1=(70,290)，目标1，普通1/特别3，守卫20u/s/发现60，计时15秒。守卫与奖励初距√800≈28.284，满足半径和24加间距4；玩家与其他实体也满足初始间距。

从tick0建run，停留884tick后向右16tick。停留期间玩家守卫距70>60。右移第4步末玩家x=30⅔，守卫仍90；第5步（全局889）before_move距离59⅓，首次追逐。之后守卫每步左移⅓，玩家每步右移2⅔。

tick899末p=(60,270)、g1=(86⅓,270)，守卫距离26⅓>26；奖励距离√500>22。tick900末p=(62⅔,270)、g1=(86,270)，守卫距离23⅓≤26；奖励距离√(400+484/9)≈21.302≤22，首次领取且达到1分，同时到时。结果必须保留score1/goalReached=true/timeout=true并以caught只结算一次。

分别重置后删守卫执行相同完整输入，tick900为timeout；再关闭计时相同输入为win。三次不能直接把tick置899。AI11只在实际运行生成@3后才能引用caught变体；未执行时不能复制K03填入。

### 扫掠切线且步末分离见证

R0-RT-06中p=(20,20)，n1=(70,50)，远处n2=(900,500)，目标2。向下3tick后p.y=28，再向右19tick。tick21末p=(68,28)，距n1为√488>22；tick22线段到(70⅔,28)，最近比例0.75，最小中心距22，步末距√(484+4/9)>22。

因此tick22须第一次领取n1；只看after_move端点会误判不接触。真实包同时保存起止轨迹及after_move positions。略大于阈值、零相对运动、clamp后路径还有独立低层几何输入，它们单列自动化单元证据，不能代替上述完整run。

### SHA-256黄金向量

C10源semantic_projection_example中的canonicalJson按UTF-8无BOM/换行取字节，预期 `sha256:7a0710df8324cf21b85d04ba8fa62f03f62feb3c46e95dca31557facd488aaf9`，对应目标6的risk源，不能拿scene-a目标10硬比。

机器清单 `goldenCandidateVector` 保存独立Python标准库按C10/policy@2投影得到的完整hashInput、canonicalUtf8及字面期望摘要；它不是产品实现运行结果。候选为scene-a完整副本，操作goal10→6与detect180→140，requestId=`a1000000-0000-4000-8000-000000000002`：

- candidateHash：`sha256:560da260f37a0fa316b6884b5676146a8d4e2890e9fb0f24e755b99ffb5f8b5e`。
- candidateSemanticHash：`sha256:7c52455c7b1080ef1c92951e18613eadaa26b1234238c4a22f3298b988088665`。

对象键/实体顺序变化应不影响对应摘要；操作顺序必须保留并影响candidateHash。主题影响candidateHash、不影响semanticHash。build/artifact/输入/authEpoch不擅自加入policy@2摘要，但仍为独立确认门。预期与实际不能同时调用同一个产品canonicalizer生成。

## 4 执行与证据采集

按P00唯一DAG推进；先T01文档/摘要/命令，再T02单tick和T03运行证据，之后T04真实面板与T05具体候选；T06费用模型另确认，之后才串真实AI。每个分支实际记录命令/输入、预期、实际结果、第一分歧及原始证据，禁止只写“正常”。

全部真实run统一落 `evidence/r0/<build-id>/04_runs/<runId>/`，其余索引使用P03的00_manifest至10_decisions目录。caseId/trialId/requestId关联这里的run，不另造case运行根。至少保存：

- 实际Node/OS/设备/浏览器及合同/registry/预算/policy版本，source/lockfile/buildHash/runtimeArtifactHash和指纹；未用浏览器填不适用。
- 完整不可变initial Document及presentation、project/revision/semanticHash，候选完整operations/candidateState/candidateHash及原基准/授权关联。
- 每tickNode实际消费输入；真实浏览器另保存发送/接收/生效tick、连接代数/消息序号、暂停/继续/失焦/断连/心跳/丢墙钟记录。
- 已提交事件、末态、断言预期/实际、原生trialStatus、实际执行区间及未覆盖项。
- @3使用唯一字段startPositions/endPositions/closestTickFraction/minCenterDistance/contactThreshold/endpointCenterDistance/contacted和对象ID；不输出语义含混contactDistance。before_move与after_move阶段另记，不用轨迹字段改写position采样身份。
- fault的attemptedTick/lastCommittedTick只进diagnostics；未提交临时领取/得分/终局不能进入玩法事件或AI事实。截断报告容量、总已提交数、丢弃数及保留区间，缺前因如实未知。
- 实际执行者/审阅者和来源类别、限制、失败退路及复验入口。截图辅助证明面板操作，不能替代输入/候选摘要/唯一领取/费用账本。

重放生成新runId，正规化比较事件序号/因果引用时保留原包；同构建同环境关键tick/分支/计数/终局必须一致。独立数值验算若需容差，主实施者须事先冻结，且不得扩大Runtime接触半径。

## 5 必须保留的失败退路

非法结构、坏expectedValue、坏第二操作、占点、旧ID及旧基准均整批零写入。保留输入、差异与原作，给出具体字段错误；不能静默改目标、搬空位、重绑实体或部分提交。合法两物交换按最终完整候选验空间，不能被中间重叠误拒。

候选无执行器not_run，环境/预算/不可玩blocked，内核/断言故障failed，全部禁止应用。纯主题仅静态例外。合法caught可技术passed，但未触发的收集/追逐/计时仍未覆盖；180tick不可能证明最短15秒timeout。

关闭、取消、revision变化、writer/scope撤销和晚到结果均由Node同队列复核；重新开AI不能复活旧authEpoch。关闭先于dispatch则零新发送，dispatch先则如实在途且费用可能未知。假adapter只能证明本机门禁，不能证明供应商取消免费。

浏览器或新R0服务环境受阻，记录UI blocked并继续已获授权的CLI任务；不换入口运行旧被拒原型。Node会话内重连只取只读快照并暂停；进程退出后重载fixture，不声称恢复作品。R0不实现完整C09两阶段恢复，工程证据留档与费用账本持久化不等于作品备份。

## 6 主实施者必须登记的事项

清单 `notesForRootDecision` 给出未默选的输入：

- 实际成年人操作者、人工语义审阅者及可用性；没有人则对应结果缺证，不能模型代填。
- 唯一代码根的物化fixture/input/黄金字节/环境与构建指纹；暂存文件不能直接充当运行证据。
- 独立数值报告如需容差，执行前统一锁定；布尔判据、tick和计数仍精确。
- T06准确provider/model/SDK/价格/金额/token批准和凭证流程。本协议不设置临时金额或选模型，也不授权出站发送。
- 若想扩大到持久恢复，必须另立已获授权的风险任务；当前只验证诚实的会话退路。

T00文档冻结完成不等于R0技术通过。R0技术通过、真实AI小集的语义结果、实验是否执行完、是否值得继续自研分别裁决；反例、等效或更差结果都保留。
