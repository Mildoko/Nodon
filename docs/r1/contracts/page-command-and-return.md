---
id: r1-page-command-and-return
version: r1-prep.2
date: 2026-11-02
status: 非执行页面合同，推荐供用户采用；实际验收均未执行
task: R1-P02
---

# 页面意图、来源返回与精确焦点

本合同落实09计划P01/P03的DG02与R1-P02-01，不实现路由或测试。仅有一份Node权威作品和CommandQueue；页面可存未提交输入/视图选择/来源栈，不能建立另一份可写文档。正式实现根仍为`/Users/dmy/Projects/Nodon-R0`。

## 1. 路由、context与命令信封

建议学生origin路由为`/s00`、`/s01/:presetId`、`/s02/:projectId`、`/s03/:runId`、`/s04/:projectId`、`/s05/:runId`、`/s06/:projectId`、`/s07/:contextId`、`/s08`；成人独立origin `/admin`为S09。路径仅用于定位，均先核Node发行会话绑定，不含口令、key、writerToken、AI正文或授权能力。projectId/presetId/runId不自动授权，也不接受用户提供文件路径。深链没有来源时先验证对象存在/可读，显示明确安全返回目标；不能回任意最近作品、默认切另一档案或创建空run。

Node管理`contextId`并验证其中身份关系；浏览器可提议视图锚点，不能自报权威内容/权限。上下文至少含：

- `route,contextId,originScreen,entryAction,sourceReturnContextId`，栈每项保存实际页面及当次来源，不用裸history.back推断。
- `workspaceId,profileId,workspaceGeneration,serverEpoch,projectId,revision,semanticHash,writerEpoch`；无作品页明确null，不能沿用另一作隐式值。
- `contentRef=currentDraft|preset|snapshot|frozenDraft`，适用的snapshotId、左右比较侧与每侧冻结引用；冻结草稿必须固定内容身份，不能读取不断变化的当前稿。
- `runId,generation,runSource,playPurpose=current|comparison|peer|preset`与不可变启动版本；`eventId/selectedEventIds/afterCursor/selectedGuardId`。
- `requestId,candidateHash,baseRevision,grantEpoch`及请求原上下文；只读回答不借这些字段得到应用权。
- `selectedEntityId/ruleId`、滚动/折叠、`focusKey={action,entityId?,kind?,side?,sourceRef?}`。focusKey不是“第一个同名按钮”，必须回原行/原侧/原控件。

跨页意图由Node校验来源身份和权限后回`contextId/projectionSeq/transitionReceipt`；合法业务命令信封另含`intentId,expectedRevision,writerEpoch`及最小payload，返回applied/rejected/duplicate与真实revision/保存事实。操作前确认基准、失效零写。async结果回同步队列重查；队列不得await。读取、选择、导航、折叠、预览不增revision；业务提交成功一次revision+1。输入发送/接收/effectiveTick与游标依ADR-R1-03，认证依ADR-R1-02。

## 2. 每页来源、暂停、返回与权限

以下是完整的页面责任矩阵。所有返回先验证context仍属同profile/workspace；丢失或已删对象提示原因并回所属面板标题，不能定位同名别物件。

| 页面与route | sourceReturn与必需context | 打开/暂停/返回/焦点 | Node权限边界 |
|---|---|---|---|
| S00 `/s00` | 本机列表/起点卡、列表滚动、具体卡或projectId；保同会话草稿引用 | 到S01后返回原卡；继续先查Node有效内存文档/写会话；无来源回列表标题。不因列表换页恢复run | 只列本profile工作区可读作品；list失败是错误而非伪空库；继续不隐式接管 |
| S01 `/s01/:presetId` | S00原卡/目录版本/preset冻结内容/preset run | 仅控制起点只读run，返回原卡；以此创作后进入新作S02标题/保存状态。离开running先暂停，重玩新run | 先玩不创建；明确创建intent幂等，新projectId/revision0与起始快照同事务，失败保内存未存，起点零写 |
| S02 `/s02/:projectId` | 来自S00继续/S01创建/导入/另存/历史来源；当前draft选择/原focus | 打开编辑/模态前暂停running，回画布不自动续；去证据/版本/帮助保存具体来源，关闭回原行/规则卡 | writer才能命令/AI应用/恢复；read_only可看/导出/另存，接管必须独立明确；失锁不自动保存 |
| S03 `/s03/:runId` | 原S02/S05/比较侧run、event/cursor/guard及原focus | 打开仅暂停该running；选/展开是只读，关闭回真正来源原run/event/focus；已删实体定位历史，不定位别物件 | 核run归属/启动版本；去修改只定位当前对象不授写权；解释需有效发送grant；旧@2不可补@3见证 |
| S04 `/s04/:projectId` | 原页、命名/自动/冻结草稿左右引用、侧/滚动/focus | 打开暂停running；左右试玩各用冻结run并返回原侧；关闭回原来源；恢复后选择/保存事实按新revision更新 | 可读比较，writer才恢复/命名/删除；只读可另存。恢复两阶段，第一阶段未落盘不得替换 |
| S05 `/s05/:runId` | playPurpose/runSource、固定contentRef、实际S01/S02/S04/S06来源及focus | 纯试玩无编辑网格/发现圈；暂停/重来只动该run；去观察/帮助先暂停；返回不续，不复活终局；同伴必须走交还设备确认 | 只读run视图，不写启动快照；peer不可通过返回露工作台/成人区；交还后才回S06作者入口 |
| S06 `/s06/:projectId` | 作者来源、固定快照/版本/hash、交接模式及原focus | 准备取消回原作者页/控件；同伴试玩→交还设备→S06准备页，作者再明确进入编辑 | 程序写权、原内容使用许可、云AI发送独立；A03-E核对不冒充DRM/可验证授权；无同伴走自测并保真实来源 |
| S07 `/s07/:contextId` | S02意图或S03选证，绑定project/revision/run/event/request/candidate与具体发起focus | 打开暂停running；“收起AI/返回来源”保有效任务；“取消请求/不用此候选”终止；answered“关闭回答”回ready。恢复面板显示同一任务，不重发 | 本地帮助无需AI；发送/应用均由Node核范围/预算/epoch/writer；旧回答定位仍核上下文，不能跨作品 |
| S08 `/s08` | 首次实际来源/选择/scroll/focus；重复打开不压自己；清除申请绑定workspace/generation/operationId/payloadDigest/原清除focus | 设置不清原保存错误，返回原页/原控件；暂停running不续；仅申请影响→独立adult-origin受限清理确认，取消回S08原控件；C2数据库删除、迁移备份/文件清单实际清理与C2-final最终commit三者齐后才回空S00并解释外部副本，db_deleted/中断/备份残留仍clearing | 偏好非作品命令；AI仅只读，无通用S09菜单/启停/key/额度入口；workspace-wide clear须成人本次重新认证＋<=60秒单次动作能力，普通profile不得清全工作区 |
| S09 成人origin `/admin` | 成人启动器入口；内部认证门/管理context；不继承儿童来源栈 | 未认证只有认证/失败/安全返回；成功后焦点管理标题；logout/过期清门内缓存与焦点回认证标题；“返回创作界面”先退出管理 | 每次请求真实成人session；供应商key只原生Keychain桥，管理口令必要本机认证通道；logout与关AI是独立动作 |

同伴S05“交还设备”不是安全身份认证，但必须遮挡作者工作台且要求作者明确回S06；如果实现无法保护跨profile材料就停该交接入口，不把只读视觉当权限。S09返回创作界面只打开显式绑定profile/workspace的安全S00，不能把管理投影塞进学生history。

## 3. 未提交输入、dirty与同会话返回

先处理未提交输入：合法单值Enter/失焦提交一次；联合两分值只有显式应用整组；非法文本/未应用联合值切页时就地“修正/放弃输入/取消切页”，Esc仅取消该输入。不能截断、半提交或用导航伪造成命令。Escape顺序：未提交输入→唯一模态/抽屉→暂停running；它不等于一键放弃作品。

已提交dirty在同作品普通可逆导航无需反复确认，Node继续唯一草稿与自动保存。切作品/关闭/清除可能失去未持久内容时，清楚列project/revision与四个独立动作：保存、本会话保留内存（仅Node持续持有时）、正式导出、取消。保存失败保内存并停留风险提示；导出仅“已交给浏览器下载，请确认文件”，不清dirty/failed，不自动授权离开。明确放弃草稿须独立影响确认，不能作为导出默认后果。

冻结DG02推荐：Node按projectId持同会话唯一有效草稿及writer会话。S00继续/再次打开必须先核该引用，有效就回原revision/dirty/failed，**不得先盲读Repository旧版替换**。失锁时旧内存保只读可导出/另存，不能覆盖新写者。只有无有效内存、作者明确放弃、或真实Node进程重启才从Repository最后持久点读取。进程关闭不承诺恢复未存草稿；“同会话回来”与“实际重启读回”证据分列。Node容量上限见ADR-R1-01，达到上限必须明确处理草稿，不能静默驱逐dirty。

save n与再改n+1：n实际持久成功仅更新persistedRevision=n，当前仍dirty；保存事实由Node所有页共享。浏览器刷新或切页不复制草稿、不重置费用/网络/成人开关。workspace clear必须先有成人本次重新认证的单次能力，Node在准入与C1提交阶段重查action=clearWorkspace/workspaceId/generation/operationId/payloadDigest/expiry<=60秒/成人session与epoch；能力仅Node内存，不进URL/DOM或持久浏览器状态。清除确认不是通用S09管理入口，未认证的S08只显示范围概述，不泄露其他profile内容。

清除能力由同步队列reserve防并发，C1同一事务写clear_journal消费回执与generation屏障，持久消费线性化在C1提交。C1最终准入前取消零清理写、回原S08控件；普通profile、成人过期、旧generation、并发重放或换payload全部拒绝，重复已完成operation仅可查询原回执。C1确定失败作废能力，未知先查journal不重发。C1已获最终准入后Node拥有清理，即使浏览器关闭或成人随后退出，也按journal完成/恢复C2，不伪称取消回滚；重启不复活内存能力。C2整体指数据库删除（journal=db_deleted仍clearing）、可信清单内应用迁移备份/相关文件实际清理、C2-final元数据最终commit（journal=deleted/最终clear tombstone/active）三项。只有C2-final完成才显示已清除、空S00或新会话；中断或备份残留保持clearing不发writer，可导出仍实际存在材料，不补造已删内容。清理先封门/持久generation屏障，旧页与迟到保存/模型不能重建内容；不擦管理认证/Keychain/独立费用账本。

## 4. R1-NAV-020通用另存副本冻结

接受明确可读、结构合法的当前可写稿、只读稿或选中冻结快照（可不可玩）；与恢复、导入、接管分开。确认前绑定`sourceContentRef/source projectId/revision/hash/snapshotId?/side`与唯一幂等intent；源基准变动则提示重新选择，取消不分配ID。

确认后Node分配新projectId/revision0、新写会话；`sourceProject`记录此次直接来源身份/适用snapshotId/revision/hash，新起始snapshotId/body使用新身份/revision0/sourceRevision0，originSnapshot按合同保最早已知端点。默认只复制所选完整内容＋新起始快照，不自动带全部命名/自动历史、undo、run末态/事件、AI会话或授权。新副本不因来源相同获得AI范围或原内容许可。

新作与起始快照引用同事务成功才显示已保存/已留版本；事务失败保新副本内存并明确“新副本尚未保存”，可重试/导出，原作及其dirty内存零写。确认/失败均进入清楚标身份的新副本S02，焦点标题及保存状态；保“回原作/原比较”入口，回S04恢复同侧/冻结项/scroll/focus，失效回比较标题。取消回具体另存控件。跨project使源未提交AI终止，新作试玩另建run，不继承旧终局。

## 5. S07折叠、取消、回答与上下文失效

- 同作品、同revision/run选证、同writer/grant仍有效时，“收起AI/返回来源”保pending/validation_pending/proposed等有效任务，提供全局任务标记；再开仅显示该request，不重发、不改基准。普通只读UI折叠不改变context，不偷重置availability。
- “取消请求/不用此候选”明确终止pending/验证/候选，清ops/operations/requestedOps；请求可能已经计费，不承诺返费。取消后迟到供应商/试跑结果只可记实际审计/费用，不可恢复候选。
- answered是directions/locate/explain/clarify只读结果，不携带应用操作；“关闭回答”回ready。选方向/回答澄清发新请求与新基准，不把上一回答直接当命令。
- 换project、任一revision、绑定run/事件/比较侧等实质请求context变更、writer丢失、grant变更/撤回/到期、成人关闭、workspace clear或重启均终止相关未提交态并清可执行操作。只读历史回答可按历史证据方式显示失效原因，但不能可应用/可新定位到另一作。恢复面板/重新授权/undo/同hash不复活。
- 全站同一关闭图标固定表示“收起”，终止动作必须有明确“取消请求/不用此候选”标签；answered使用“关闭回答”。不能路由不同却暗变同一按钮后果。

## 6. 来源真实与待验记录

浏览器可上报输入事实，不可自报`human/peer_human/adult_proxy`当可信结论。Node固定适配器来源如machine_browser_input/automation_test，可信操作者声明须与独立组织见证编号、实际参与范围、时间/输入事实关联；没有见证则保unknown/machine事实，不因UA、手点checkbox或客户端role改名。成人口令登录不证明目标儿童或独立非开发者操作。旧机器证据不改标签；新增来源适配须版本化，人工判读/真人/模型/机器证据分册。

非执行JSON用例仅供审阅，不能填产品通过。后续T01/T02/T14提供各自局部切片；T16依赖齐后执行全部跨页UX/NAV、尺寸/缩放/焦点及异常，不能把需后继页面的全链验收设为早期阻塞循环。实际run、认证、保存重启、模型与真人结果当前均`not_executed`。

来源：本vault09 P01 §2/S00–S09/§4、`页面与跳转矩阵.json` NAV006/NAV020/NAV026及S07–S09；P03 §1/3/4/5/6/8；06 R00、C13、C17；08/05现状“没有产品保存、机器标签固定、首输入/长run未知”。本合同推荐DG02冻结值；DG01位置改变及DG01/DG03新增全工作区清除的真实成人门/单次能力/受限adult-origin确认路径仍须用户采用存储/认证ADR和C17/S08告知修订，本文不执行迁移或清除。
