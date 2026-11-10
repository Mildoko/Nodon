---
adr: ADR-R1-01
version: r1-prep.1
created: 2026-11-02
status: 推荐方案已具体化；DG01待用户采用；未实施、未实测
ownerTask: R1-P01
---

# ADR-R1-01：独立本机SQLite作品仓库

## 决定与采用边界

推荐Node端独立SQLite Repository保存作品、快照、分配器、工作区generation和写权fence。Node Document/CommandService仍是唯一作品修改入口；浏览器只发命令和读投影。费用账本、成人认证资料与供应商密钥分别保管，不把已有AI费用库扩成作品库，不把数据库文件作为.nodon交接文件。

这是R1-P01的非编码准备交付。用户采用R1工程计划不自动采用本ADR的DG01变更；本文件不回改06/v3正文，不声称DG01/G-ADR或R1实施准入已经通过。待明确采用本决策及下述C17变更后，才可实施相应存储链。其余G-R0/G-E/实施门独立判定。

实施目标仍是`/Users/dmy/Projects/Nodon-R0`；本轮只产文档和非执行案例，没有创建数据库、选装驱动或运行产品。当前R0事实仍为内存作品、一次undo、无正式持久化/文件闭环；2026-10-28的221/221历史证据不能证明本设计已实现。

## 两方案比较及推荐理由

- **推荐Node SQLite**：同一数据库事务可覆盖文档、快照、allocator、generation、fence和操作收据；存储ack由Node自己确认，重启可独立校验。浏览器关页不取消已准入保存，跨浏览器绑定同一工作区可看到同一持久作品。代价是改变C17存放/清除边界、需要明确本机路径、启动器和工作区绑定；SQLite原子性不自动解决CommandQueue、迟到结果与UI状态竞态，必须执行配套合同。
- **保留浏览器IndexedDB备选**：最贴近C17现有“当前浏览器”语义；数据随浏览器档案隔离。Node需产不可变checkpoint，唯一受控协调器在IndexedDB事务写入、读回并给Node可核对收据；Node要处理关页、重载、跨标签独占、profile丢失与存储回收。前端任意ack不够证明保存；不能页面自己merge作品或另造writer。浏览器存储不能与Node事务天然原子，必须另定并验证跨进程prepare/commit、重启日志与fencing协议后才可沿用。它不是同期开第二可写仓库，也不是Node失败后静默切换方案。

SQLite官方说明只允许一个并发写事务，`BEGIN IMMEDIATE`会在开始时取得写事务或返回busy；此特性适合本机单存储调度器。它不提供本产品的身份和写权语义。推荐精确实现为现有冻结Node **24.21.0**内置`node:sqlite`的`DatabaseSync`，放在专用`node:worker_threads` Worker内以单连接FIFO执行。无第三方驱动依赖。官方对应版本文档表明该模块为Stability 1.2 release candidate，DatabaseSync API全部同步，支持busy timeout和backup；这一稳定等级是选型已知限制，需随DG01采用，不写成稳定2。T00只核对目标包确为24.21.0、记录其实际bundled SQLite版本/编译设置并验证协议，不把驱动重新留待研究；不可用时停T03提交ADR修订，不能静默换库。[SQLite事务文档](https://www.sqlite.org/lang_transaction.html)

## DG01：C17必须明确采用的变更

现有C17写“当前作品、意图、说明和快照在浏览器”“清除当前浏览器本应用作品、快照、恢复点和偏好”。采用本提案后，需要明确替换为以下产品语义，尚未写回原基线：

1. 作品、保存的意图/说明、快照、来源映射和本工作区偏好保存在运行本机Node的当前OS用户数据目录；不是仅保存在当前浏览器。运行事件/undo/AI请求正文继续默认仅内存，不混入作品库。
2. macOS推荐根为`~/Library/Application Support/Nodon/workspaces/<workspaceId>/repository.sqlite`。`~`在启动器按实际OS用户解析；Windows/Linux由安装包按各自用户数据目录解析，同样不落源码仓库/当前工作目录，不接受浏览器传来的任意路径。发布包实际路径须在S08只读说明及教师交付材料核对。文件可能受OS备份/同步策略影响，不宣称只有浏览器能访问或绝对匿名。
3. 清除改为“清除此本机教学工作区的所有作品、快照、恢复点、来源映射、会话草稿和工作区偏好”，影响绑定该workspace的所有浏览器/标签。S08仅申请/读范围；独立adult-origin受限确认panel须成人重新口令认证后Node签发≤60秒单次clearWorkspace能力，绑定workspace/generation/operationId/payloadDigest，在C1 generation事务中消费并记无秘密journal；普通profile会话不得删除其他profile资料。确认框显示工作区名称、影响范围、先导出和取消。不能仍称“只清当前浏览器”。另一workspace和其他OS用户不在本次范围。
4. 清除使本workspace全部作者写会话、writerToken、AI课堂授权和在途未提交请求失效；成人管理凭证、Keychain中的供应商密钥与独立费用账本不擦除，AI不会因重进工作区自动开启。用户要清这些资料须走各自管理动作；S08说明边界。
5. 清除成功只承诺应用控制范围内的逻辑删除与旧会话不能重建；OS备份、下载文件、教师副本、供应商记录分别说明。不承诺介质安全擦除。迁移备份若存在须纳入清除范围并登记，不能清完主表却留下应用可恢复作品备份。
6. 不按浏览器自动导入/合并历史资料。R0没有正式产品库，不把机器证据或designOnly样例作为迁移输入。未来若已有IndexedDB作品，须另立明确迁移同意、校验、来源与失败退路，保持原件至核对完成；本ADR不授权静默抓取。

此变化是存放位置、可见范围、告知和清理责任的重大变更；采用记录至少包括ADR版本、上述六点（含清除成人单次动作能力这一DG01/DG03交叉变更）、采用者/时间与对应告知修订版本。未采用时维持DG01待决，T03及其后继持久链不实施；不靠把文档标“accepted”自行过门。

## 工作区、作者档案与访问边界

Node登记`workspaceId`和`profileId`。workspace是显式命名的本机教学资料容器，profile是本机作者档案，不是学生实名账户。Node发行的不透明浏览器会话绑定`workspaceId/profileId/workspaceGeneration/serverEpoch`；浏览器URL/localStorage/profile字符串都不能自己选择另一个档案或取得写权。

首次安装由本机初始化流程建默认workspace/profile；新浏览器/隐私窗口不自动枚举全部作品，先通过受控本机绑定流程进入目标档案。同一profile绑定同workspace的其他浏览器可以看到相同持久作品，但同projectId仍只有一个写者；不同profile默认只见自己的项目，教师管理访问由P02真实成人鉴权另定。工作区清除是workspace范围，不能用profile筛选偷偷缩小告知的删除范围。

这属于应用层便利隔离，不是OS用户/恶意本机用户的强安全隔离；共用OS账户可直接访问文件的现实须在教师材料说明。外部可编辑文件交接使用C10新身份导入，不靠更改profileId转移原作。成人认证、AI发送授权、作品写权和内容使用许可分别判断。

## 一致性与可落地时序

沿用现有同步FIFO CommandQueue，其拒绝Promise；ProjectStore仍唯一mutation。新增RepositoryCoordinator负责异步存储调度，不能把`await`放进CommandQueue。队列只做短同步准入、捕获不可变副本、安装pending操作/屏障、回执重验和Store应用。存储调度器单连接串行执行事务；每次完成作为新队列项重新核对`serverEpoch/workspaceGeneration/writerFence/operationId`，不由Promise回调直接写Store。

保存允许后续编辑；保存r的ack只确认r，不能把r+1标saved。恢复第一阶段、接管、clear、迁移则先装明确屏障，拒绝相关新业务命令，事务结束回队列再开门。接管必须在新fence落库后才给新写者发token。clear先落generation屏障，再删数据；删除阶段C2包含数据库删除、应用文件/备份清单清理和C2-final元数据提交，三者全完才清除成功并重新开门；即使删除失败，也不复活旧token/旧异步回执。Worker只持数据库连接/冻结payload，不拿ProjectStore、CommandQueue写者或领域可变引用；父子以postMessage结构化克隆通信，不共享可写内存。Worker退出使所有未决操作变result_unknown，先重开/读回核对，不重发业务变更。详细步骤与失败语义以配套[Repository合同](../contracts/repository-schema-and-transaction.md)为准。

SQLite事务配置推荐单库`journal_mode=DELETE`、`synchronous=EXTRA`、外键检查开启，事务短小且用`BEGIN IMMEDIATE`，有限busy等待后报可重试失败。选择rollback journal使工作区清理/迁移文件范围更直观；不得有第二进程绕过调度器写库。启动时查询确认实际PRAGMA值，未知设置被忽略不能当成功；SQLite及硬件/文件系统的持久保证仍须目标设备故障验收。[SQLite PRAGMA](https://www.sqlite.org/pragma.html)、[SQLite rollback锁机制](https://www.sqlite.org/lockingv3.html)

所选Node模块的版本/API依据[Node24.21.0 SQLite文档](https://nodejs.org/download/release/v24.21.0/docs/api/sqlite.html)；Worker通信依据[同版Worker文档](https://nodejs.org/download/release/v24.21.0/docs/api/worker_threads.html)。专用Worker是隔离同步SQLite阻塞的应用设计选择，不声称Worker能提高异步文件I/O本身效率。

## 后果、备份与停止线

新作+起始快照同事务；命名8/自动2/会话undo redo50；恢复先存保护点再应用；allocator单调不回退；保存精确revision ack；clear generation防复活；完整接口和非执行复审情境见合同。Snapshot不是运行状态备份，恢复不复活旧run/旧AI。

普通用户备份/交接为严格C10 `.nodon.json`导出和回导核对；数据库副本仅供受控迁移/故障恢复，含本机管理元数据不能当作品文件交给同伴。迁移前通过SQLite支持的一致性备份方式产生一份受控备份，列入workspace清理清单；迁移验证成功后清理临时备份，失败保原件只读，禁止删库重建来假修复。

DG01采用只解决存储决策，不代表实测完成。磁盘满/权限错/损坏/未知新Schema、并发接管、断线ack、恢复两阶段、clear崩溃与迟到异步结果都须T03及后继真实验收。除文档静态检查外本轮全部未执行。

## 来源与后续

- `09_R1…/P00_R1范围准入与分批交付总纲.md`：DG01/G-ADR及非编码范围。
- `09_R1…/P03_共享工程合同与验证证据案.md`及任务JSON `R1-P01`：唯一文档、存储回执、恢复、另存副本与clear要求。
- `06_v3…/R00_设计基线与跨案合同.md`、C09/C10/C17：50/8/2、身份、文件及原浏览器告知。
- `08_R0实施记录/05_自家产品完整性与可行性核对_2026-11-02.md`：R0现状与历史证据边界。
- 与`ADR-R1-02-adult-auth.md`、`page-command-and-return.md`保持同一workspace generation/撤权/返回语义；不得由页面重复维护写权或草稿。

下一动作：独立文档复核关闭协议冲突；提交DG01六项变更供用户采用；采用后准备对应告知与清除文案，满足其余准入再实施。
