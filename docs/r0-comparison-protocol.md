# R0 对照与请求冻结协议

作者：GPT6.1SolHigh。日期：2026-10-28。基线：review.4-r0-20261028。此文件及两份manifest只冻结未来步骤，当前所有操作、运行、真人、模型、费用及成熟工具产物均未执行。暂存目录不是正式代码根；由root同步唯一代码根后为整个T00包计算最终指纹。不得在看见模型输出后修改题、变体、顺序或判准。

## 冻结输入与身份

`verification/model-request-manifest.json`为38个逻辑请求槽的唯一清单；每槽有唯一requestSlotID、父槽、题号、repeat、phase、初态引用、前置、人类步骤和输出期望。实际requestId/attemptId/provider ID在运行时另填，不用槽号伪装已发送请求。每槽保留A1/A2两个attempt位置，A2只在实际允许的有界修复/重试发生时计入；不得为填表消费。

14题×2=28初始；09/10每次一个方向后续=4；11每次一个解释后续=2；ACCESS、IDEMPOTENT、CANCEL、TIMEOUT各一=4；共38槽，最多76次供应商尝试，并发1，SDK隐式重试0。未知取消/超时保留在途位置和费用预留，核清前后续阻塞，不重编号挤掉必跑题。T06才批准准确provider/model/金额/token及出站范围，本文件没有替代批准。

FX-A以review.3 `ud02/risk.nodon.json`完整受控文件为源，把目标6设置10、说明文字同步10，正式引用`verification/fixtures/scene-a.json`；FX-B完整引用`ud02/garden.nodon.json`，正式路径`verification/fixtures/scene-b.json`；FX-A-G6为A仅目标10→6、其他内容不变，物理路径`verification/fixtures/scene-a-goal6.json`；其无AI镜像为`verification/fixtures/scene-a-goal6-mirror.json`。保留其他坐标、规则与计时limit。源文件SHA256在manifest锁定，修改后的semanticHash必须由T01真实现重算，不能复用源摘要。FX-E11必须由T03真实RT07同tick达标/接触条件生成；固定初态、输入、选中链、再验输入对应唯一case-manifest的R0-RT-07 caught记录（caseID/variant为查找键，不使用不存在的文档锚），不用K03或临时挑更容易的事件。FX-E12已选定“无实际事件”，不在看到输出后改成截断变体。主题目录顺序冻结为`theme_snack`、`theme_r0_contrast`，二者皮肤映射均`snack_player_01`；root材料化`config/catalog.json`配色目录并锁指纹，第二主题不交模型任选。

AI11固定`R0-RT-07/caught`：`verification/fixtures/terminal-conflict.json`和`verification/inputs/terminal-conflict.json`。A替换实体为p(20,270)、g1(90,270)、n1普通(70,290)，目标1、普通1/特别3、守卫20/发现60、启用15秒；idle884tick再right16tick，独立预期第900tick得分达标/接触/到时且caught优先。每repeat真实重置、新run；实际事件未生成不得发送解释。再验沿同输入。人可选模型实际提供的最小合法改法；若实际提供n1移到(40,290)可选择，但不能硬塞为模型选项，也不要求假设一定改善。无AI侧镜像p(940,270)、g1(870,270)、n1(890,290)，物理fixture为`verification/fixtures/terminal-conflict-mirror.json`，input与再验引用`verification/inputs/terminal-conflict-mirror.json`（idle884+left16），必须真实运行。

## 配对、变体与执行顺序

`verification/comparison-manifest.json`固定28个配对块、34个初始/后续phasePairedID。A=真实AI，B=直接控件加相同程序规则/事实帮助。AI侧始终P05初态。B侧对所有实体作整场景x→960−x镜像，位置请求同步镜像、运行输入dx→−dx；规则、目标、数量、稳定ID、y及材料不变。h1因此从(300,190)移至(420,220)，唯一白名单操作名为`move_entity`。镜像projectId固定为源projectId加`-mirror`，实际runId独立；只改projectId不改semanticHash，镜像几何自身仍按规范重算摘要。反射保持距离和圆形接触几何；必须真实运行镜像作品，不能改写已有事件制造镜像证据。两次repeat分别重置初态；先前经验照实保留。

repeat1奇数题AB、偶数BA，repeat2全部反向。每块先完成一侧初始及其既定后续，再做另一侧。固定块顺序：repeat1的01–10、13、14，repeat2同序；再repeat1的11、12，repeat2的11、12。ACCESS先执行；IDEMPOTENT/CANCEL/TIMEOUT在主集后按此顺序执行，满足T09前置并避免未知在途提前堵塞主集。网关没有完成前只能准备，不把ACCESS先发当T06先于T00/T01。

每侧15分钟，含阅读、操作、模型等待与支持；准备时间、作者操作、支持者时间、等待分别记录。超时/自愿退出保留结果与限制，不新增请求补完成。现有材料、硬件、帮助机会相同；某侧额外帮助记入成本，禁止暗加支持。两侧独立重置，不能把第一侧产物带到第二侧。偏离顺序要留原始时间和理由；T10不得回放、重排或补写时间戳冒充交错。

B侧按各题独立手动预期判断最终目标、约束、实际操作和结果，不要求AI的kind/DTO、候选试跑、后续请求或整批一次revision。08用两次直接命令分别改目标/发现，最终满足双目标即可，操作数与revision如实计成本；13实际手动删g1且保留计时关闭/limit45；14查看能力说明后保留/退出零写入。B侧方向/解释阶段由人依现有事实帮助独立完成，不复制A侧模型结果；其不足或保留照实记。

## 人类选项与实际输出

下述AI选项规则仅适用于A侧。09只从模型实际给出的布局方向选择，10只从实际给出的时间方向选择，11只从实际解释给出的合法最小改法选择。人记录选项原文/ID、理由和当前基准，子槽作为新请求、新门禁和新授权；选不到、拒绝或保留，则对应子槽失败/阻塞，不能Agent代选、捏造选项或额外澄清调用。12/14保留/退出，13手动删守卫，均不增加后续AI请求。

A侧玩法候选完整副本校验、同candidateHash与当前build/artifact真实180tick冒烟、人工确认一次提交、正式新run分列。纯主题走静态目录/摘要及runtime_not_applicable；不造Runtime passed。未触发领取/追逐/超时的机制不声称见证；冒烟不证明可解、公平或好玩。解释事实逐条比真实@3、原revision、规则和实际值；模型建议/假设与实际再验结果分列，允许反例或仍缺证。

humanOperator、semanticReviewer、matureToolOperator当前均未指派。Agent操作可记machine_browser_input/automation_test，机器内核为machine_runtime；不能填写真人作者、主观帮助或人类金标准。用户本人可作内部developer_self_test；不得标independent_non_developer。未指派不阻止内核/命令/候选工程，仅阻塞所需人工操作、语义裁决、比较及整体去留结论。模型/费用未批仅阻塞T06真实发送与其下游，不阻塞内核。

## 成熟工具独立同目标比较

预选MakeCode Arcade，仅承接P04已有计分/计时/重叠事件资料核查。当前没有启动、制作、真实运行、项目或成功结果。T04按manifest的MC-G01–03分别实际操作，每目标30分钟，准备/学习/支持时间另记；产物须可操作且有原始步骤/运行。比较作者目标和支持负担，不要求像素重叠等于Nodon圆形扫掠，不因缺Nodon式事件字段自动判MakeCode失败。

工具不可用/不适合则比较blocked，记录原因；替代工具必须先重冻协议，不看完AI再挑工具制造优势。T10只审计T04/T07/T08已采集产物、caseID/pairedID/请求槽/attempt/顺序/费用，不新增AI调用。资料阅读不能填实际操作。没有成熟工具实际产物则C20对照未完成。

## 判准、来源与收尾

两侧同判：显式约束保留/遗漏/未知；方向有无真正可执行差异和作者选择；解释引用/版本/实际值是否忠实、事实与假设是否区分；能否作下一步验证或有依据地拒绝/保留。额外帮助、等效、额外负担、更差、缺证必须链接具体原始证据；不用字数、接受率或模型自评分替代。操作数、作者/支持者耗时、等待、所有尝试、失败/拒绝/取消、已结成本及未知预留分别列。

主集初始28为独立分母；后续6、探针4和修复attempt分列，不以修复覆盖首次。实验收尾可以含失败/阻塞，不等于限定技术通过；七操作/混批与两条真实链仍须计划要求的真实最小覆盖。AI功能通过与同目标额外价值分别裁决；只参数题全对不证明模糊设计/理解增益。单成人内部证据不支持儿童学习、普遍减负、广泛采用或模型稳定率。

记录实际build/environment/fixture/prompt/规则/目录/策略/输入指纹、操作者来源、步骤、期望、实际、第一分歧、状态、证据路径与审阅人；状态只用未执行/通过/失败/阻塞/不适用及理由。证据落正式实现仓库`evidence/r0/<build-id>/01_protocol/`、`07_ai/`、`09_comparison/`，两链只引用原始证据。不得在Obsidian或暂存区伪造未来运行证据。

## 交root合并裁定

已与root及case作者对齐FX-E11的RT07生成/再验条件、A/B来源与第二主题ID/映射。root同步唯一代码根、材料化受控fixture/目录并计算三个文件最终指纹；这些是T00跨作者引用一致性，不请求额外模型调用。实作未产生实际事件/目录不使协议变成已通过。
