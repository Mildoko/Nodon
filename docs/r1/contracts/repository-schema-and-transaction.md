---
version: r1-prep.1
created: 2026-11-02
status: 非执行数据与事务合同；依ADR-R1-01/DG01待采用；所有运行验收未执行
ownerTask: R1-P01
---

# Repository Schema与事务合同

本文定义推荐Node独立SQLite作品仓库的可实现协议，未创建实现Schema/产品/测试代码。字段是内部设计约定，不改变C10 `.nodon.json`字段。存储位置、C17变更和采用边界见[ADR-R1-01](../adr/ADR-R1-01-repository.md)。

## 1 不变量和身份

- Document/CommandService是唯一作品业务入口，ProjectStore是唯一内存mutation；Repository持久化程序承认的不可变文档，不反向从页面状态merge。UI输入草稿、运行、比较、请求和持久文档分开。
- `projectId`不可变；每次成功内容业务命令revision+1，包含undo/redo/恢复；保存/命名快照/导航不增revision。`semanticHash`由Node按C10重算，非语义改动也增revision并使旧AI候选失效。run是否失效按语义及终局合同，不因恢复旧hash复活。
- `workspaceGeneration`、`writerFence`单调不回退；`serverEpoch`每次Node启动新随机身份，不从文件或浏览器恢复。它们都不进入.nodon或semanticHash。
- 持久`committedRevision`是最后真正提交的checkpoint；会话`memoryRevision`可领先。revision不会因undo/恢复倒退；崩溃未保存内存不保证恢复，重开以最后commit为基准，并用新serverEpoch阻断崩溃前请求/候选/输入。`storageSchemaVersion`、文件formatVersion、runtimeVersion、catalogVersion、buildId是不同版本维度。
- 请求幂等键`operationId`由Node登记，绑定workspace/generation/project/操作类型/捕获内容摘要；重复同键同载荷返回已知结果，不重复创建或恢复；不同载荷同键拒绝。浏览器重连查询结果，不能随意再创建身份。

## 2 内部记录（逻辑模型，非执行SQL）

所有项目型主键/唯一约束包含workspaceId；Node连接按可信workspaceId选库，不能让请求指定文件路径。外键不得跨workspace。

- **workspace_meta**：`workspaceId, storageSchemaVersion, workspaceGeneration, lifecycle(active|clearing|migration_failed), schemaMigrationId, createdAt, clearedAt`。generation和非内容tombstone在clear后保留，防止旧请求重建。清除失败记录错误类别/操作ID，不含作品正文。
- **profiles**：`profileId, workspaceId, displayAlias, createdAt, preferences`。不存实名、参与/研究表或成人密码；档案是应用隔离边界。clear删alias/偏好和绑定，保留最小generation元数据；重进显式新建/重新绑定profile。
- **projects**：`projectId, ownerProfileId, documentBody, revision, semanticHash, createdAt, updatedAt, committedAt, lastCommitId, formatVersion/runtimeVersion/catalogVersion`。documentBody为严格域文档，含现有作者字段和sourceProject；不存run/候选/密钥/撤销栈。`revision`即committedRevision，Node读回重算hash及全部限制，不信自报hash。
- **snapshots**：`snapshotId, projectId, kind(initial|named|automatic), name, sourceRevision, documentBody, semanticHash, createdAt, originSnapshot?`。为消除“起始版本是否额外占位”的歧义，本P01新增明确工程提案：起始快照是一条`kind=initial`的命名区条目，计入8；该配额解释随DG01/生命周期方案一并待采用，不能回写成v3原文已规定。默认可见名“起始版本”。命名至多8，自动至多2，当前文档另存。名称最多24 UTF-16代码单元，空名按单调`namedSequence`生成“版本N”，序号不因删除倒退。命名满由作者明确删除（确认）或导出，不覆盖。自动点满时同事务只选未被未决恢复pin的最旧automatic；先将引用该点的已终结intent之外键显式置NULL（保protectionEndpoint），再删旧点并插新点。两个点都pin时拒绝新恢复而不替换内容；不影响命名配额。
- **project_counters**：`projectId, allocatorHighWater, namedSequence, writerFence`。allocatorHighWater和writerFence唯一持久权威都在此表；projects不存这两列，API视图通过join投影。实体ID按受信现有类型/命名格式生成；分配高水位持久且不可因undo/restore/删实体减少。可按namespace记录高水位但只有一个权威。项目读回可校验当前/全部快照最大ID不超过高水位，超出标损坏不得降低/猜修。
- **write_leases**：`projectId, issuedFence, serverEpoch, ownerClientSessionId, tokenDigest, expiresAt, generation`。issuedFence仅是该lease发行时绑定值，每次写必须等于project_counters.writerFence，不能反向更新权威fence。token为Node随机秘密，库只存摘要；所有写查当前绑定、generation、epoch、fence和有效期。时间到期只是触发收回，不允许无持久fence更新即复用旧token。
- **import_map**：`importOperationId, projectId, inputProjectId, inputSnapshotId?, localSnapshotId?, inputRevision, inputSemanticHash`。记录本次输入直接端点与本地新ID，不冒充完整来源链；不存原文件全文/路径。
- **operation_receipts**：`operationId, operationKind, generation, projectId?, captureRevision?, expectedCommittedRevision?, committedRevision?, commitId, payloadDigest, outcome, completedAt`。成功收据与业务变更同事务；结果查询返回最小必要字段。clear删除含项目的收据，clear自身留不含内容的generation/操作结果tombstone。
- **restore_intents**：`restoreOperationId, projectId, generation, writerFence, preRevision, targetSnapshotId, targetBodyDigest, protectionSnapshotId?, protectionEndpoint(snapshotId/sourceRevision/semanticHash/createdAt), state(protected|applied_saved|settled|cancelled), committedAt`。第一阶段成功同事务记录protected；第二阶段持久成功记applied_saved。protectionSnapshotId是真实可恢复自动点的可空外键；protectionEndpoint仅是无正文审计端点，外键解绑后不承诺还能恢复。protected/result_unknown期间必须pin实际保护点；applied_saved/settled/cancelled为终结态；settled只表示作者后续修改已可靠保存并结束此次恢复，不伪称目标中间版曾单独持久。仅是崩溃解释，不启动时自动恢复；不保存旧授权或旧run。
- **clear_journal**：`workspaceId, clearOperationId, sourceGeneration, targetGeneration, payloadDigest, capabilityId, issuedByAdultSessionIdDigest, admittedAt, state(admitted|db_deleted|deleted|failed), completedAt?`。capabilityId不是秘密token；仅记录已获准动作的最小审计绑定，不保存口令/原secret。PK(workspaceId,clearOperationId)，UNIQUE(workspaceId,targetGeneration)，journal与C1 generation变化同事务；C2/重启只凭此记录续办已经准入的清除，不发行新能力。
- **workspace_tombstones**：`workspaceId, generation, clearOperationId, clearedAt, outcome`，无正文、作者文本或project名；应用重建空workspace仍沿同一generation，不把数据根删除后generation归零。

### 2.1 具体字段约束与索引

这是待采用的内部Schema v1（`storageSchemaVersion=1`）约束，不是可执行建表脚本。全部表用SQLite STRICT，非可选字段NOT NULL；枚举CHECK白名单，所有外键开启且同事务维护。文本以UTF-8存储，JSON无HTML执行；所有JSON在Node严格域校验，数据库再CHECK json_valid及UTF-8字节上界。SELECT使用参数绑定与显式列，不接收客户端SQL/表名/路径。

- **通用键**：新生成workspace/profile/project/snapshot/operation/commit/serverEpoch/clientSession ID为Node UUID v4小写36ASCII字符，DB CHECK长度/允许字符，主键唯一。外部sourceProject/originSnapshot ID继续按C10接收域校验，保留在JSON内，不强制转换为本机UUID。hash/payloadDigest为`sha256:`+64小写hex（71ASCII），CHECK形状；验证仍必须重算。
- **计数/时间**：revision、sourceRevision、generation、fence、highWater、sequence为INTEGER，范围0–9007199254740991；fence≥1，generation初始1。不能SQLite整型溢出或JS不安全整数；到上限拒绝新分配/变更，原作可导出。毫秒时间戳同为安全非负整数，createdAt≤updatedAt/committedAt；客户端不能指定系统时钟。排序用commit顺序/ID破同秒并列，租约不依赖客户端时间。
- **内容**：documentBody和单snapshot body各≤1,000,000 UTF-8字节，项目字段title1–40、instructions0–200、authorNote/designIntent各≤120 UTF-16代码单元；命名name≤24同计数，Node检查不使用SQLite length替代UTF-16。Node写时保持body.projectId/revision/semanticHash与索引列一致，DB对同字段json_extract CHECK。snapshots body.revision=sourceRevision且body.projectId=本机projectId；originSnapshot另存原端点，不覆盖本机字段。规范化、格式与预算仍按C10，字段未知拒绝。preferences为白名单JSON≤4096字节，profile displayAlias≤40 UTF-16单元且非空，不要求实名。error只存≤64ASCII错误类别，不存自由堆栈/路径。
- **project及profile**：projects PK(workspaceId,projectId)，FK(workspaceId,ownerProfileId)→profiles；索引`(workspaceId,ownerProfileId,updatedAt DESC,projectId)`服务list。profiles PK(workspaceId,profileId)，bind状态只由Node管理。所有项目读取先以workspace+ownerProfile过滤，不能查到projectId后才决定是否输出。
- **计数及lease**：project_counters PK/FK(workspaceId,projectId)，1:1项目记录；writerFence唯一权威。write_leases PK/FK(workspaceId,projectId)，UNIQUE(workspaceId,tokenDigest)，索引`(workspaceId,ownerClientSessionId)`与`(workspaceId,expiresAt)`供失效/过期扫描。lease issuedFence/generation与项目计数/workspace元数据在事务内交叉核验；接管先删旧lease、权威fence+1、插新lease，原子提交。过期不能仅清行而不提升fence。
- **snapshot**：PK(workspaceId,snapshotId)，FK(workspaceId,projectId)→projects；索引`(workspaceId,projectId,kind,createdAt,snapshotId)`供配额/自动裁剪。initial至多1，用(projectId)在kind=initial上的部分唯一索引；initial+named总≤8、automatic≤2由同事务计数校验+数据库触发约束双重保护，超额rollback。没有“同名覆盖”语义，允许同名不同snapshotId，UI显示时间/修订消歧。
- **映射/收据**：import_map主键(workspaceId,importOperationId,inputSnapshotId或显式root标记)，FK项目；索引`(workspaceId,projectId)`及`(workspaceId,inputProjectId,inputSemanticHash)`，输入端点字段只在合法会话可见。operation_receipts PK(workspaceId,operationId)，索引`(workspaceId,generation,completedAt,operationId)`和`(workspaceId,projectId,committedRevision)`；projectId可空仅限clear等非项目操作。payloadDigest/operationKind/generation首次绑定后不可变，重复操作异payload拒绝。outcome枚举pending|committed|failed|result_unknown，committed必须有commitId/completedAt，其他状态不得伪造committedRevision。
- **恢复/清除**：restore_intents PK(workspaceId,restoreOperationId)，FK当前项目与可空protectionSnapshotId（默认NO ACTION，禁止把protected的保护点直接删掉），索引`(workspaceId,projectId,state)`；targetSnapshotId只定位已冻结目标，目标被删/换代则恢复拒绝。workspace_tombstones PK(workspaceId,generation)，UNIQUE(workspaceId,clearOperationId)，仅数字/ID/结果无内容。workspace_meta PK(workspaceId)，每库恰1行，旧generation不得删除后重用。

### 2.2 容量、收据保留和背压（工程提案，随本ADR采用）

这些是本机防无界增长的工程上限，尚非v3已承诺数值；采用前应确认，不在实现后默加限制。容量达到上限只拒绝新持久数据，不静默删作者作品/快照，当前合法内存可取回导出。

- 每workspace最多1000持久项目、100个profiles；作品/快照/映射/偏好/收据逻辑UTF-8总量上限512MiB（536870912字节），事务写前按变化量校验。触顶返回storage_quota而非假磁盘满，作者自行导出/明确删除后重试；新create/copy/import整笔拒绝。迁移/clear/保存错误收据可使用独立预留4MiB元数据额度，不能为满库而删未决记录。
- 已终结收据保留至少24小时；清理仅删completedAt超过24小时且不被任何PendingOperation/restore intent/clear/recovery引用的收据，按旧到新。未决pending/result_unknown与未完成restore/clear意图**永不按时间淘汰**，必须有读回裁决后才终结。每workspace常规收据上限100000条（含未决），清理后仍满则拒绝新的create/copy/import/新快照/新恢复/普通save任务，保已有未决操作结果查询、重试同ID、read/export和clear；普通内存编辑可继续但明确未可靠保存，不能堆积新的异步保存。clear安全控制收据走上述预留额度；预留也耗尽则停新准入、保只读取回，人工故障处置。
- 结果过了24小时且收据已合法清理，返回result_unknown，不把无收据当未执行。Node已有projectId/snapshotId/commitId映射可readback核对；无法证明未执行时不得自动重放create/copy/import/恢复，作者需明确发起新的副本动作，新operationId保留“不确定旧操作可能已完成”的说明。工作区clear tombstone不按24小时删，当前generation元数据一直保留。
- 每project最多1个在途save+1个合并待保存目标；每workspace存储任务队列最多64项（含在途），载荷累计≤16MiB，超出返回repository_busy不默排无限队列。clear/接管屏障命令保留独立2个控制槽，先封门并排在既有已准入任务之后，不能为了快删除跳过fence顺序。Worker一次只执行1个事务。
- Node每workspace最多20个唯一会话草稿，单个≤1,000,000字节；20个都有dirty时新open/create拒绝并提示先保存/导出后明确关闭，不隐式驱逐dirty。已保存且无活动view的草稿可LRU释放，重开从库校验。单个项目undo/redo合计保存最近50个原子历史条目，引用最多51个共享不可变文档版本（每版≤1,000,000字节）及每条≤4096字节元数据，总上限64MiB；不得为节省实现改成不足50层。第51个新编辑才淘汰最旧历史，undo/redo移动同一游标而非复制另一套50版；新编辑清redo。
- 迁移备份每workspace最多1份，完成核验即删除；失败保原件+这一份备份、禁止每次启动再复制。临时导出不在磁盘缓存（内存返回浏览器）；迁移临时文件总量最多原库大小+64MiB，磁盘不足则不启动迁移。错误元数据日志最多1MiB滚动，不含正文/凭证。SQLite文件页与journal可能大于逻辑量，另按实际磁盘剩余提前报告；不以逻辑quota代替真实I/O错误处理。

### 2.3 精确存储运行时与lease参数

推荐冻结Node24.21.0内置node:sqlite `DatabaseSync`；一个长期存活专用Worker持每workspace唯一连接，父线程只发结构化克隆的冻结任务。使用DatabaseSync的参数绑定prepare/run/get/all，外键开、double-quoted literals关、allowExtension=false、defensive=true、timeout=2000ms；`journal_mode=DELETE`、`synchronous=EXTRA`逐项读回确认。SQL/建表文本由受信程序固定，未知参数拒绝，禁止ATTACH用户指定库/扩展。Worker退出后父线程标结果未知并封存储准入，重新open/readback确认后恢复；不把业务payload自动重放。

写lease TTL **15秒**，浏览器/Node绑定会话每**5秒**续租一次，续租同样经短准入和worker事务校验issuedFence/generation/serverEpoch；数据库expiresAt与进程单调时间deadline均需未过期，不因系统时钟回拨延长。续租被队列/磁盘阻塞超过期限就失权，UI只读可取回；忙时不能先本地延长lease再假称续租成功。到期后重新获取必须提高writerFence并发新token，不能旧token续回来。所有写，包括自动保存/ID预留/snapshot/restore均验证lease；clear只使用下述成人重新认证签发的单次workspace动作能力，普通profile/token和project lease均不构成清除授权。

实体ID每次预留**32号**，按现有命名namespace记录高水位，存储worker同事务CAS highWater，产生内部reservationId绑定epoch/fence/generation；若剩余不足本次命令需要则再预留，取消号不回收。lease失效后未用号废弃，新的writer从持久highWater之后继续。预留不是作品内容，不改变revision/semanticHash；高水位只在project_counters写一次，projects/UI仅join读值。

模块/API适配依据[Node24.21.0 SQLite文档](https://nodejs.org/download/release/v24.21.0/docs/api/sqlite.html)，其Stability1.2 Release candidate风险随ADR明确采用；Worker机制依据[同版Worker文档](https://nodejs.org/download/release/v24.21.0/docs/api/worker_threads.html)。本轮仅核文档，没有运行Node/数据库或装依赖。T00核版本/编译设置并验证该选型，不重新留出驱动选择空白。

## 3 命令信封与端口

全部写请求先过Node会话/工作区绑定。内部信封含`operationId, workspaceId, profileId, workspaceGeneration, serverEpoch, clientSessionId, projectId?, expectedMemoryRevision?, expectedCommittedRevision?, writerFence/token?, operationKind`。浏览器只提交意图与它看到的版本，Node从会话取绑定并比对；不接受客户端自报权限/真实人标签。错误返回稳定类别、可重试性和当前合法版本/写权状态，禁止泄露另一profile内容。

- `create`：起点/已校验文件/明确副本内容→新身份、起始快照、分配器和收据同事务；失败保留未可靠留存内存副本。
- `list`：仅当前profile可见持久项目及Node唯一会话草稿摘要，dirty/failed明确。不能列到别的profile。
- `open/readback`：读可信库→严格校验→回队列按generation/epoch重验→建立唯一活动草稿。存在同会话dirty草稿时优先返回它及最后commit摘要，不能覆盖。重开/刷新不等于从磁盘回读验证。
- `compare-and-save`：捕获不可变文档、allocator高水位、r、期望持久版本c及fence；事务CAS，返回实际r及commitId。r可大于c+1（防抖跳过中间checkpoint），不得r≤c覆盖。相同operationId重试幂等。
- `snapshot`：冻结目标版本并与引用持久保证；对当前dirty创建命名快照时当前文档checkpoint+命名条目同事务。选中已持久快照做比较只读，不消耗额外配额；比较当前草稿为只读冻结内存候选。
- `restore`：下述两阶段；UI无法直接调用覆盖documentBody。
- `copy-as-new`：C10新身份规则和NAV020另存副本；不获取原作写权、不改原作。
- `clear`：工作区屏障/撤权/generation/删除协议，不接受前端逐表清空。
- `export`：Node从当前合法内存或明确冻结快照产生严格C10载荷；读出不修改项目/保存状态。

接口端口名为职责合同，不宣称现在代码已有这些API。浏览器下载ack、HTTP200发送完或SSE到达不等于数据库commit。

## 4 同步CommandQueue与异步存储调度

### 4.1 通用流程

1. **同步准入项A**：CommandQueue校验当前session/generation/fence/revision/权限及操作前置，捕获不可变payload，登记`PendingOperation`和唯一operationId；需屏障的操作在此封门。立即返回accepted/pending，绝不返回Promise供队列等待。
2. **队列外准备**：RepositoryCoordinator调度独立、串行存储工作，解析/序列化/校验/文件I/O在队列外。异步准备完成不能直接写Store。准备结果需要再通过同步准入项A2核对捕获身份，作废则不发写事务；发出的任务携不可变守卫。
3. **存储事务B**：同一workspace单连接FIFO，`BEGIN IMMEDIATE`，重验库中的generation/lifecycle、project committedRevision、当前fence/lease及操作幂等。写文档/快照/allocator/收据后commit；错误rollback并回错误结果。所有fence/clear操作也走该存储FIFO，不能开旁路连接先修改。
4. **同步完成项C**：结果作为新CommandQueue项，查PendingOperation仍匹配operationId/serverEpoch/generation/fence/项目/阶段；已取消/清除/接管/换代就丢弃对Store的应用。保存ack可更新相符的`lastPersistedRevision`但只在当前memoryRevision=r、内容摘要吻合、无更晚未决保存时标saved。UI仅读这个投影。

异步B可能已commit，C才发现已失效；不得尝试用旧payload补写当前Store。随后新写者open/readback获得数据库实际状态。仅“忽略旧响应”不足以防旧写覆盖：B本身必须核对持久generation/fence/CAS；接管/clear在单一FIFO中排序，并在授予新会话前等屏障commit。旧操作若在屏障前commit，后续clear会删掉；若屏障后执行则守卫失败。

每project最多一个在途save；后续编辑把最新快照合并为待保存目标，不把未经确认的c用于并行CAS。完成C确认c推进后再发下一save。明确保存可flush到指定revision并等待该收据，300ms只是调度。超时结果未知则查询同operationId/readback，不能把“超时”当确定rollback。

### 4.2 队列屏障和取消

`projectGate`取normal/restore_protecting/transferring/read_only；`workspaceGate`取active/clearing/migrating/unavailable。受门阻拦的业务意图返回busy/read_only，不偷偷排成稍后自动写的无限队列。clear/接管获准时同步失效PendingOperation授权、AI候选/验证、run输入和自动保存定时器；撤销回调也必须带相同epoch/generation。

普通undo/redo可在save r在途时应用为r+1；旧save r仍可commit但不会清r+1 dirty。restore第一阶段则冻结项目所有内容命令/undo/redo/新快照/实体分配，等protect ack后重验，避免“保护的是旧草稿而替换的是新草稿”。clear同时封workspace全部项目门。未知存储结果期间门不自动打开；先查操作结果。

### 4.3 ID分配与撤销

实体新ID采用Node受信分配器。每次需新ID时先从已持久预留区间取号；预留耗尽则异步持久提高highWater，再回队列重验意图基准，之后同步执行业务命令。预留本身不增作品revision，不先把未留号的实体应用到Store。取消/失败的预留号可以空耗，绝不回收。崩溃后从已持久highWater之后再预留，避免重用未保存草稿曾发出的ID；导入按全部文档和导入快照最大ID初始化。

undo/redo栈各为同一会话的操作历史，上限50个可撤销原子操作，整批AI算一次；undo移动游标并产生新revision，redo同样产生新revision，新编辑清redo。重开磁盘作品/Node重启不承诺栈存在，快照恢复作为一个原子内容操作可撤销，但不会恢复被清除的授权/终局；UI文本框内的字符undo由控件处理。栈中引用稳定实体ID，allocator不随文档回滚。若现有R0仅一层undo，必须改正式实现后再验，不能通过改标签算50层。

## 5 保存/新作/导入/副本

### 5.1 新作

Node先生成新projectId/revision0与结构合法内存内容，分配新snapshotId。create事务同时插入项目、计数器、起始命名快照、write lease与成功收据；任何一项失败整体rollback。成功后C核对身份再显示“已保存/已留起始版本”。失败可以留Node唯一pending-new草稿供重试/导出，明确“新作品尚未可靠保存”，S00不能当持久最近作品；重试同operationId不得重复创建。

### 5.2 保存状态

成功内存命令→dirty→300ms后saving(r)。r的事务以expectedCommittedRevision=c CAS更新至r，记commitId。期间改至r+1：ack(r)只更新lastPersistedRevision=r并保dirty(r+1)。保存失败保有效内存、lastPersistedRevision、最后提交时间，显示failed并给重试/导出；不假回滚。CAS冲突/失锁转read_only并停自动保存，保内存可导出/另存，不能自动覆盖或用hash相同豁免revision。

Node重启前未提交草稿不保证恢复；UI须明确会话内保留与可靠保存区别。`saved`只指具体revision的本机事务完成，不能声称云备份、浏览器文件下载或当前所有内容已安全。

### 5.3 导入

按C10先限UTF-8文件字节≤1MB，再严格版本/字段/类型/文本长度/引用/位置/预算/所有快照校验，未知脚本/URL/格式整份拒绝。`designOnly/notExecutable`样例不入正式导入器。合法零奖励/总分不足仍可存草稿、禁止试玩；不自动改规则补足。

新projectId/revision0；输入命名快照最多2，各分配新snapshotId，本机documentBody身份改新项目/0、sourceRevision0；保留已有最早originSnapshot，缺失才用输入来源初始化。sourceProject记本次直接来源，importMap保存直接端点映射。新起始快照+导入所选命名快照最多3条，同create事务；不重复当作旧本地修订。origin端点不证明许可；文件不带writerToken/凭证/运行/AI/研究/undo或allocator。

### 5.4 另存副本 NAV020

显式选择当前合法内存或明确选中冻结快照，确认目标名称后新projectId/revision0/sourceProject与新起始快照同create事务。默认不复制全部命名/自动历史，原作零写；只读/失锁原作也可走此退路。取消零创建；失败保pending-new内存副本及准确来源，界面仍明确副本未保存，不误导航到原作或假称已落盘。作者显式确认另存时，Node立即产生独立pending-new projectId和内存context并切入新副本S02；原作context成为sourceReturn，原作零写且不能沿用原作writerToken。失败仍停在这一新身份的未存副本S02，可重试/导出，不回原作误编辑。成功条件只控制saved、持久最近作品列表和“已留起始版本”的显示；不能把进入新副本context也延迟到commit成功。

## 6 恢复两阶段

1. 作者选targetSnapshot，预览差异后确认。A捕获当前合法草稿revision p、targetBodyDigest、fence/generation；项目装restore_protecting门，旧run输入先停，AI不能继续提交。未准入/取消零写。
2. **保护事务R1**：在存储FIFO排在先前已准入save后；先按下述pin规则确认有空槽或可裁剪点；以其真实已提交版本为CAS基准，同事务把恢复前草稿p写为当前checkpoint、新建automatic保护点、自动点裁剪至2、写restore_intent(protected)与R1收据。保护点保存全部内容及p，current身份不变。已有命名8满不阻止此事务。失败rollback：不替换当前内容、不删旧自动点，解除项目门后仍是原草稿，给重试/导出；未知结果先查收据。
3. R1成功后C回CommandQueue，重验pending restore/generation/epoch/fence、memoryRevision仍p、内容与target冻结一致。clear/接管或取消失效则不应用target，保护点可留但不启动后台自动恢复。有效时**同步内容命令R2A**：只复制target内容字段（标题/说明/意图/备注/scene/rules/presentation及适用版本），保留当前projectId、当前sourceProject/来源链、本机importMap与allocator highWater，生成revision p+1；目标旧snapshotId/sourceRevision不能变当前身份。清AI请求/候选、按运行合同失效旧run，ended/fault/invalidated不复活。解除项目门，显示“恢复已应用，正在保存”。
4. **恢复保存事务R2B**：以R1实际p为期望持久版提交p+1，写R2收据并把restore_intent记applied_saved；C仍精确ack。期间若作者又改至p+2，ack(p+1)不能清p+2 dirty。R2保存失败保留p+1或更新内存及R1保护点，显示“恢复已应用，尚未保存”，允许重试/导出；不能宣称回滚，也不能偷偷应用第二次恢复命令。
5. R1后R2A前崩溃：重启读回p和protected标记，只显示“恢复前内容已保护，所选恢复未确认保存”，不自动应用target。R2A后R2B前崩溃同样只能恢复持久p，未保存恢复内存可能丢失。R2B已commit但ack丢失：重启/查询得到p+1与applied_saved，不再次revision+1。启动不复活旧会话授权。

### 6.1 自动点配额、未决pin与连续恢复

automatic保护点总≤2是硬限制。protected以及其任何result_unknown阶段引用的保护点都pin，不能为新恢复而删；即使它比别的点旧也不可裁。两个slot都pin时新恢复返回restore_protection_slots_full，当前内容零替换，允许查询/读回解决前次操作或重试其保存，不静默解除pin。

R2B真正commit后同事务记intent=applied_saved，才释放该点的pin（点本身仍保留直到正常自动裁剪）。保护阶段已commit但作者取消/接管作废时，先使pending操作不可能再应用；确认所有在途结果并readback后，显式记cancelled，才释放pin。未知结果不能因作者点取消就终结或删保护点。恢复p+1失败后可重试同R2保存；若作者在R2保存失败后继续编辑，Node为后续checkpoint信封附`settlesRestoreOperationId/appliedRevision`，只允许指向当前会话命令链里已经R2A应用且未决结果已读回确定的restore；存储事务核对该intent、epoch/fence/generation和新revision≥appliedRevision，提交后同事务记settled并释放pin。这样保存的是作者后续最新内容，不能伪称目标中间版曾单独保存。未携此受信关联、跨重启缺命令链或任何结果未知时仍pin，不以“当前有保存”盲解；可查询读回或作者明确放弃后记cancelled。重启protected只作提示，用户明确不继续并经读回终结后可变cancelled，不自动恢复。

新R1事务选可裁最旧点时，先显式更新引用该点的所有**终结态**intent：把protectionSnapshotId置NULL，保留原snapshotId/sourceRevision/hash/createdAt在protectionEndpoint。随后删除该automatic并插入新保护点，整个事务原子；任一非终结引用存在则该点不在候选集，数据库FK兜底拒删。审计端点不是内容备份，UI不把NULL外键端点当可恢复版本。终结intent收据保留遵守24小时/引用窗口；终结记录可以随后清理，不以保留永久FK破坏2点配额。

因此连续第三次及更多**成功**恢复可正常裁掉最旧已解pin点；一未决+一已完成时仅裁已完成点；两未决时安全阻止第三次。workspace-wide clear是已经成人授权的删除整个工作区，不受保护点pin阻止，但仍按C1/C2 fence清全量，不借恢复裁剪偷删pin。

恢复阶段1暂封项目变更是协调约定，不是“队列内等待异步”。作者取消保护等待时，C从pending状态识别取消；已经commit的保护点可保留并如实告知，不能声称取消后没有任何已提交动作。恢复确认前的取消零写，与确认后发起存储的取消含义分开。

## 7 多标签与接管：先fence后授权

- 同projectId只允许一个Node写会话。新标签open默认read_only，能看持久投影、导出自己合法冻结内容和另存，不能直接接管。BroadcastChannel通知可提升体验，正确性不依赖广播成功。
- 写者心跳续租和所有修改都验Node token绑定；连接断开暂停输入/请求，过期后旧token无效。服务重启轮换serverEpoch，库中旧lease不得继续使用；启动先事务撤销旧lease/提高fence后才发行新token。
- 显式接管先展示“另一页可能有未保存修改；不会把该页草稿覆盖到当前作品”，允许取消。确认后CommandQueue给项目装transferring屏障，立即取消旧写会话的自动保存调度、候选/验证和输入授权；旧内存草稿冻结成只读抢救视图，不丢弃，但不得再执行undo等业务命令。
- storage FIFO处理先前已准入写之后，事务CAS旧fence、提高fence并更换owner/tokenDigest，附最新committedRevision。其间旧B可能在屏障前commit，该版本属于接管前合法写，必须被新作者读到；屏障事务后旧fence写全拒绝。ack前不向新标签发行可写token。
- 完成C重验当前transfer op/generation，读取并校验事务确定的最新checkpoint，新写者从它建立草稿。不得把旧写者未commit内存自动移交；旧页明确read_only，可导出/另存自己的冻结内存。新token不能使其旧回调合法。
- 接管失败保留文档及旧冻结内存，旧token不自动复活；状态显示“接管未完成，暂只读”，查询结果或通过显式重新获取写权流程恢复。fence失败不能开两个writer。未知结果查operationId，禁止盲目二次接管。

`writerFence`是数据库单调号；`writerToken`是不可预测会话秘密，两者都须核验。只用时间戳/标签ID或localStorage锁不合格；只有revision CAS不足以阻挡清除后同ID再建。

## 8 清除工作区与防复活

确认范围承接DG01：本workspace所有profile作品/历史/草稿/偏好及应用迁移备份；不删成人管理凭证、供应商密钥、费用账本、外部下载/教师副本/OS备份。由于会影响其他profile，普通学生会话不得清工作区。

S08只能发起清理申请、读范围和取消；真正确认在独立adult-origin的受限清理确认panel，经成人重新输入口令认证（不是打开S09菜单）后，Node在内存签发单次动作能力。能力绑定`action=clearWorkspace, workspaceId, generation, operationId, payloadDigest, capabilityId, adultSessionId, expiresAt`，有效期至多60秒；payloadDigest绑定明确显示的范围/告知版本，不接受客户端自报“已认证”。确认前校验recent auth/当前generation/未撤销成人session。能力不发普通学生origin，不放URL/localStorage/作品；浏览器通过adult-origin受控请求提交，Node主线程先reserve为in_use防并发消费。

C1准入前取消零写。C1失败能力永久作废，重试需新成人认证；C1结果未知查clear_journal，不重复消费或换ID盲重发。C1已提交则清除已获准，C2和重启只依据持久journal检查action绑定/generation/state/operationId续办，不能要求已过期内存能力在重启后仍有效，也不能把journal当可重用清除授权。成人退出/撤权发生在C1准入之前则拒绝；发生在C1之后不倒转已准入清除或复活资料。此授权边界是DG01/DG03待采用的新增影响。

以下C2整体完成指数据库删除、可信文件清单清理与C2-final元数据提交全部完成；仅数据库删除commit不是总体成功。

1. 成人能力经队列校验并reserve后，同步安装workspace clearing屏障，取消所有自动保存调度；使此workspace全部writer/session、AI发送grant、未提交请求/候选/验证与输入失效，冻结活动run。`clearOperationId`与原generation g登记到PendingClear。Node同时登记仅用于本次清除结果查询/失败取回的短期recoveryContext，绑定原profile、clearOperationId及允许读回的项目，不含写权；不能凭旧g token调用一般open/list。客户端无需在线配合。未完成前新create/open-for-write/undo/恢复/导入/另存都拒绝；只读/导出只在未删且仍可访问的冻结内存上明确提供，不悄悄重建数据。
2. 存储FIFO先排空已准入写，再以事务**C1持久屏障**把generation从g CAS至g+1、lifecycle=clearing、提高所有写fence/撤销lease、同事务插入clear_journal(admitted)记capabilityId/绑定及消费，不存secret，并生成无内容clear意图。数据库C1写守卫含已reserve的capabilityId/op绑定、未到准入期限及当前g；不能在认证库/作品库之间假称跨库原子消费。所有排在C1后的g操作都因generation不符拒绝。C1提交前不向任何新session发g+1写权。
3. **C2删除事务**重验clear_journal已准入的action绑定/op/g→g+1及g+1/clearing，删全部项目/快照/恢复意图/来源映射/计数器/作品收据/档案别名/偏好；保workspace generation，仍置lifecycle=clearing并记journal=db_deleted；此时不写最终完成tombstone、不发新session。按外键依赖顺序删除restore_intents→snapshots/import_map/lease/counters/项目收据→projects→profiles，journal/meta另保；项目关联记录整体事务删除，失败rollback不能部分删除。应用掌控的迁移备份/临时文件另按可信清单删除，须等这些也完成；随后做C2-final短元数据事务，重验同clear_journal/g+1，写journal=deleted/最终tombstone并置active，才能报总体清除成功。若文件删除失败/崩溃，保db_deleted/clearing并在重启继续清单，不提前恢复新writer；已删作品不假称回滚，仍可访问的合法Node冻结内存仅按recoveryContext取回。不得用任意浏览器路径删除文件；不把删空表称安全擦除介质。
4. C2-final成功后同步C重验clearOperationId/epoch/generation，销毁Node内存草稿、undo/redo、run/事件/AI内容及旧导航context，S00显示空态。新进入走显式profile绑定与新Node会话；不会继承旧AI grant，管理认证的存在不自动开启AI。
5. **C1失败**：持久作品未清除；仍撤销旧进程内会话/授权，workspace显示clear_failed只读，可在合法可访问内容导出后重试。不能继续接受旧token的保存；要恢复编辑必须经一次显式重新获取会话/fence流程，先确认没有未决clear任务。
6. **C1成功而C2失败/崩溃**：generation已g+1，旧页永不再有写权；C2数据库事务未commit则保留作品，已commit/db_deleted但文件清理未完成则作品已删且有残余备份待清，始终处于clearing，仅恢复清除状态/只读取回，不发新writer。只读取回须经对应profile的受控重新绑定或仍有效recoveryContext校验，不能因进入恢复模式就列出其他profile作品。重启检测clear意图后继续/提示完成清除，不自动把资料当正常最近作品。给出“清除尚未完成，暂只读，可重试/取回”的真实状态，不假空首页成功。
7. C2-final commit但ack丢失：按tombstone/operationId读回成功，不重建旧档案。所有A/B/C携g或旧serverEpoch的延迟结果即使内容合法，也不能改Store、发新token、安装草稿或执行create。已在网络的旧UI命令同样拒绝，不能只靠清空浏览器缓存。

若清除后的用户要从自己另存外部文件重新导入，是显式新操作/新身份；旧页面后台重放不是重新导入。clear不撤回已commit手动/AI修改的历史账务记录，也不声称遥删供应商资料；费用库独立且保留必要最小元数据。

## 9 dirty导航、关闭与导出退路

- 离开dirty/failed作品时按页面合同提供保存后离开、保留本会话内存、取消；明确放弃需另说明影响。选择保留时Node DraftRegistry只保一份按workspace/profile/project绑定的草稿，S00带“未保存”，再次open优先它，不用磁盘旧版覆盖。UI本地输入尚未提交不是已应用作品，另有输入提示。
- “本会话”指本Node进程及有效工作区，浏览器刷新可重新附着同一草稿，Node退出/重启/clear/显式放弃会失去该保障。切profile不把草稿暴露给另一profile；不静默把所有dirty当永久保存。退出风险在界面说明。
- 导出当前结构合法内存，包含合法不可玩草稿；可选最多2命名快照，按C10生成UTF-8 `.nodon.json`。不带writerToken/fence/generation/profile绑定/数据库管理字段/allocator/费用/研究/运行/请求/undo。选择快照的身份和来源按C10映射，不能直接dump数据库。
- 浏览器触发下载后文案“已交给浏览器下载，请确认文件”；不证明已落盘/回导成功，不清dirty/failed，不自动同意导航或恢复AI候选。导出失败保内存及最后可靠checkpoint，给重试，不伪造可运行文件。

## 10 重启、迁移、损坏与磁盘失败

启动器仅Node打开受控目录，校验真实路径/访问权限及工作区归属，禁止路径穿越/随意符号链接到其他workspace；具体文件权限与OS ACL按目标包实现并验收。启动开库前阻止第二独立写进程（本机实例锁）且由SQLite文件锁提供最后事务互斥；不使用网络共享盘/同步盘作推荐根。实例锁不是数据库fence替代品。

读取`storageSchemaVersion`与迁移日志。当前支持版本才校验所有文档/快照/来源/配额/引用/hash/allocator；未知更新版本只读隔离，保原文件，不降级/清库。结构合法不代表可玩，规则注册表/Runtime缺失则标不能运行，不能重算旧规则来冒充兼容。

迁移需全workspace gate，旧会话/lease作废；先通过SQLite支持方式作一致性本地备份，登记位置、范围与清理责任（不能只复制正在写的主文件），检查可用磁盘和访问权限。迁移在事务中更新Schema/数据/版本/记录，事务成功后读回全量约束再启用新版本；失败rollback保原件和备份，只读导出/人工恢复路径。版本变化不能静默改文件format/runtime语义，涉及内容转换另有明确方案。

错误至少区分`storage_busy/storage_full/storage_permission/storage_io/storage_corrupt/schema_unsupported/generation_stale/writer_lost/revision_conflict/result_unknown`。busy有限等待后报可重试；磁盘满/权限/I/O/rollback结果不明都保Node合法内存，不假saved或无限循环。断线ack未知用operationId/readback核对，不能重复分配project/snapshot身份。损坏文档隔离不执行，不向用户导出伪合法数据；同workspace其他合法项目是否可只读取回需逐项验证，不能自动删坏项目。

磁盘故障不回写错误作品到原文件；可导出不代表数据库已经恢复。重启只展示最后可验证commit、保护点及恢复意图，不承诺所有未保存内存。运行/AI/undo/管理会话均不从库复活；AI默认关闭且发送grant不跨重启。

## 11 非执行复核案例与证据要求

下列是未来验收预期，没有执行结果；R1-P03可纳入其统一case-manifest。每例至少记录实际build/OS/Node/驱动/SQLite版本、workspace/profile匿名ID、serverEpoch/generation/fence、操作序列/故障点、内存/持久revision、operationId与commitId、实际收据/读回、UI文案和判定；日志不录凭证/作者正文。机器故障注入、真实浏览器、开发者与独立非开发者证据分别标源。

- **REP01 新作原子性**：项目写后/快照写前故障，读回两者都不存在；内存副本可导出、不能显示已留版本。
- **REP02 保存中再改**：保存r在途时编辑/undo至r+1，ack r不清dirty；下一save以c=r CAS；旧ack乱序不退版本。
- **REP03 恢复保护失败**：自动点裁剪后但commit前故障，旧内容/旧自动点不变，目标零应用。
- **REP04 恢复第二阶段失败**：保护p已提交，内存p+1已应用，save失败；保p+1和保护点，文案准确。随后新编辑p+2不被R2 ack清dirty。
- **REP05 恢复碰undo/clear/接管**：保护等待时undo被门拒绝；clear/transfer使恢复C失效，目标不迟到应用。R1已commit的保护点不被假称从未存在。
- **REP06 重启断点**：分别在R1 commit、R2A应用、R2B commit/ack前中断；读回p/p/p+1且不自动重放恢复，旧run/候选/授权不复活。
- **REP07 配额与ID**：8命名含起始、2自动、50会话撤销；命名满零静默覆盖；undo/restore/删除/崩溃后新ID不重用已预留号，new edit清redo。
- **REP08 多标签接管**：A有dirty及在途save，B确认接管；A屏障前commit可见于B，屏障后旧fence写全拒绝，A内存只读可导出/另存，C旧回调不能改B。
- **REP09 clear断点**：C1前失败、C1后C2前失败、C2数据库删除已commit但备份清理失败、C2-final后ack前中断；分别不谎报清除、保持clearing防旧写、db_deleted等待可信清单完成且不发writer、读最终tombstone确认成功。绑定其他浏览器迟到保存/create/恢复均不得复活。
- **REP10 clear边界/权限**：普通学生token、客户端伪成人布尔、另一profile凭ID、过期/撤销/异generation/异payload能力、同cap并发双消费全部拒绝，原作及其他profile零删除；受控成人重新认证后清全部workspace profiles及应用迁移备份。C1失败cap作废、C1已commit重启从journal续办而不重发授权。其他workspace、成人口令/Keychain key/费用账本不动；AI grant失效且重进默认关闭，外部副本说明准确。
- **REP11 dirty返回/NAV020**：S02→S00保会话内存→重开仍同dirty；只读原作显式确认另存立即生成独立pending-new身份/context并进入副本S02、sourceReturn仍指原作，原作零写；存储失败仍是未存新副本身份而非原作context，重试幂等且不显示已留起始版本/持久最近作品；导出不清dirty且不自动导航。
- **REP12 文件和来源**：1MB/未知字段/脚本/URL/非法快照整份拒绝；合法不可玩草稿通过；重复导入新身份、本地sourceRevision0、保最早origin与直接sourceProject/importMap，无凭证/研究字段。
- **REP13 异步恶意时序**：A2准备返回、B已commit及C排队三种位置分别插入clear/transfer/重启；旧结果不能直接Store mutation/重装writer/创建草稿，B守卫拒旧generation/fence。
- **REP14 迁移/磁盘**：Schema新旧不兼容、忙/满/权限/I/O/损坏、迁移前后崩溃、重复实例；不降级清库，不假saved，合法内存保留，原件/受控备份与clear清单一致。

- **REP15 连续恢复/pin/FK**：同项目连续至少3次完整恢复均成功，自动点始终≤2，最旧终结intent外键在同裁剪事务置NULL且保审计端点，第三次不因NO ACTION失败；一protected/result_unknown+一applied_saved时只裁后者；两个未决保护点pin时第三次恢复拒绝、原内容与两个点不变；取消但结果未知不解pin，完成readback/终结后才允许裁剪，NULL审计端点不显示可恢复。

静态复核可判字段/时序是否完备，不能替代上述真实故障、重启、浏览器和文件回导验收；本轮所有实际结果保持未执行。

## 12 来源

协议来源：P03共享合同、P00 DG01与任务JSON R1-P01；v3 R00、C09、C10、C17；R0现状以08/05记录为准。SQLite原子写/并发事实依据[事务](https://www.sqlite.org/lang_transaction.html)；配置读取和持久设置依据[PRAGMA](https://www.sqlite.org/pragma.html)；rollback journal行为依据[锁机制](https://www.sqlite.org/lockingv3.html)。队列屏障、fencing、阶段回执与profile隔离是本ADR提出的应用层设计，不能写成SQLite自动提供的保证。
