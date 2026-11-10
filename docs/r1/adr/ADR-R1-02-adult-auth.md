---
id: ADR-R1-02
version: r1-prep.2
date: 2026-11-02
status: 推荐方案已写实，待用户采用；未实现、未实测
task: R1-P02
---

# 成人认证、管理会话与课堂AI授权

推荐由唯一Node主机执行真实成人管理口令认证。S09是独立成人入口；S08只显示必要的AI可用状态。成人认证、作品写权、课堂云AI发送范围、原内容许可分别成立，任何一个不能替代另一个。本ADR是非编码准备，不创建凭证、不读现有凭证、不新增模型调用、不表示G-ADR或实施总门已通过。

## 1. 产品入口与保护边界

- 正式启动器提供两个明确动作：“打开创作界面”“打开成人管理”。成人动作打开专用回环origin的`/admin`认证门；不在S08、儿童导航或评审控制条放管理入口。推荐创作与管理使用同一Node进程的两个独立随机端口，均只bind `127.0.0.1`。URL本身不携带能力或秘密，知道地址仍须认证。
- Node对请求核对真实socket回环地址、完整Host（含本次端口）、精确Origin、Content-Type、方法及服务发行的会话；拒绝通配CORS、外来/缺失Origin的浏览器写请求、DNS rebinding及把localhost/其他地址当别名。原生启动器IPC另走受控子进程管道，不绕过HTTP校验。
- 管理静态资源同源自带，无第三方脚本；CSP至少限制default/script/connect/form至管理自身origin，禁内联脚本、eval、frame、跨源嵌入。写请求另验CSRF token，GET无管理副作用。认证与管理响应`Cache-Control: no-store`，不经service worker缓存。
- 回环HTTP不是TLS；R1不开放LAN/远程管理。cookie用HttpOnly、SameSite=Strict、`Path=/admin`与每次serverEpoch唯一名称，生存期不得超过会话；不谎称普通HTTP一定支持Secure cookie。Origin是端口级校验，cookie不是端口隔离，不能省略Origin/CSRF。以后开放非回环必须另立TLS/身份方案。
- 工作区会话由Node发行并绑定`profileId/workspaceId/workspaceGeneration/serverEpoch`；UI自报ID、角色或human布尔无授权作用。跨浏览器同OS用户不自动获同档案权限，须启动器明确绑定已有档案；这是本机便利隔离，无法防御已控制同一OS用户/进程的攻击者。恶意同用户程序、扩展或已攻陷的管理origin也不由口令方案消除。

## 2. 首次建立：只有本机一次性bootstrap

1. 首次authority记录确实不存在时，普通启动仍保持AI关闭、管理门“尚未建立”；浏览器无`claim-first-admin`接口。磁盘损坏、文件消失但存在初始化标记均进入恢复锁定，不能重新开放抢占式注册。
2. 获准成人在本机启动器选择“建立成人管理口令”，通过OS交互确认。启动器与其直接Node子进程用继承匿名管道交换32字节随机bootstrap nonce；nonce只活5分钟、一次消费，并绑定本次serverEpoch。不得进argv、环境变量、URL、终端输出或日志，也不提供浏览器可读bootstrap文件。
3. 原生安全输入窗口两次录入口令，Node校验后以原子替换写authority verifier与初始化标记。仅完整成功才消费nonce并显示已建立；并发最多一项，失败不留下半可用成人。初始化不启用AI、不配置供应商、不登记课堂同意。
4. 以后用S09口令登录；重新运行bootstrap必须拒绝。遗忘口令走第6节明确本机reset，不能删除一个文件就静默重建。

这里“成人”指由活动负责人保管该管理秘密的受托管理者，不是软件验证年龄、监护关系或法律同意。

## 3. 口令存储、失败限流与管理会话

冻结为实施目标，尚未做耗时/内存测量：口令16–128个Unicode scalar、UTF-8最多512字节，允许粘贴与空格，不静默trim/归一化、不强制字符类别。Node内置异步`crypto.scrypt`，随机salt32字节、`N=131072,r=8,p=1,keylen=64,maxmem=268435456`，verifier等长后`timingSafeEqual`。记录算法版本/参数/salt/verifier；不存明文或可逆口令。认证工作并发1，最多排队1，满则429；异步KDF在CommandQueue外完成，结果回队列重查credentialEpoch后发会话，绝不在同步CommandQueue里await。

authority与限流状态由Node写入作品库之外的本机authority状态库，macOS推荐`~/Library/Application Support/Nodon/authority/authority.sqlite`，目录0700、文件0600，不出作品/快照/浏览器存储；费用账本另库。失败按authority累计，不能用换端口/IP/浏览器绕过：每秒至多1次可接受认证；15分钟窗口5次错误锁15分钟；60分钟累计10次错误锁60分钟。返回相同的泛化拒绝及剩余等待，不泄露verifier/口令细节。失败计数和lockedUntil持久化，重启不清；时钟回拨进入保守等待/本机恢复，不缩短已记录锁期。成功清当前连续失败但保留最小审计计数；不记录输入内容。

成功发行32字节随机opaque session，Node只存其SHA-256摘要及`credentialEpoch/serverEpoch/createdAt/lastAuthenticatedActionAt`。idle10分钟、absolute30分钟，后台轮询、状态推送和失败请求不延长idle；敏感动作（换口令、原生凭证配置、额度提升、授权新的课堂范围）要求最近5分钟再认证。每项管理API都在Node校验当前会话与epochs，页面缓存不能授权。logout即时撤该管理会话、清cookie/管理缓存/表单/焦点，过期同样回认证门；会话不落盘，重启全失效。

S09口令属于成人认证秘密，必要时短暂存在`type=password`控件的运行时value及本机POST认证请求体；这是本方案对P02“成人秘密不送浏览器”措辞的明确细化。不能同时声称浏览器口令认证与“DOM绝不出现口令”。口令不得写HTML属性、路由、URL、通用状态仓库、自动保存、遥测、日志、录屏/DOM证据或作品；响应从不回显，提交/失败/离开即清输入。供应商key完全不走此输入路径，见第5节。JS/GC不能保证所有内存副本即时归零，不作该承诺。

## 4. 管理会话不等于课堂授权

Node保存独立`adultEnabled`和短期`classroomGrant`，后者绑定`workspaceId/profile scope/serverEpoch/grantEpoch/allowedDataCategories/organizerScopeRecordRef/expiresAt`，默认关闭且不自动勾选。组织者在管理中明确本场允许发送的数据类别、档案范围和结束时间；建议单场最长45分钟，超时需成人重新明确授权，不能靠导航续期。记录编号不包含真实姓名，程序不自行判断组织凭据法律效力；未知/撤回不发。R1实际模型/金额/token/attempt准入仍由DG04独立决定，课堂建议不是新增调用授权。

- logout只撤成人管理session，不隐式更改已明确的课堂开关/grant；仍有效的grant可继续到约定到期。这允许负责人退出管理后学生使用已授权课堂AI。
- 显式关AI、grant撤回/到期、profile/workspace切换、clear、Node重启立即关发送门，递增auth/grant epoch，终止所有未提交pending/proposed/validation_pending/validation_blocked/blocked/answered，清ops/operations/requestedOps。已应用作品保留；已发送的费用仍照实对账。
- 重启将运行态adultEnabled设false且不恢复课堂grant；已配置供应商不等于可发送。重新开AI、重新登录、undo、返回面板、迟到响应/试跑均不复活旧请求。新发送和候选应用各自重查所有epoch、writer、范围、预算和请求身份。
- 撤权同步执行门禁先于任何后续队列命令；UI更新目标由root性能合同统一，推送掉线也不影响Node拒绝。S08仅得“未开启/可用/网络不可用/额度不足”等派生态，无会话/verifier/账户详情。

## 5. 供应商凭证：可落实的macOS Keychain桥

推荐正式macOS包自带最小签名Swift原生helper，固定放包内`Contents/Resources/bin/nodon-keychain`，直接链接系统`Security.framework`，使用`SecItemAdd/SecItemCopyMatching/SecItemUpdate/SecItemDelete`；不依赖未经核查的npm keychain包。Keychain service使用产品标识，account由Node发行的非秘密credentialRef/供应商ID组成，条目限定本机、不同步。发布时必须锁定helper源码、构建/签名身份与条目访问控制并验收OS权限提示；这部分尚不存在，不把API名字当已集成。

**工程依赖归属**：R1-T02负责最小Swift源、Security/LocalAuthentication及必要AppKit交互、Node受控IPC桥、开发构建、helper身份/hash核验与实际本机认证/Keychain成功和失败验证；T02不能等后继T15提供helper才宣称真实认证具备，也不能以模拟OS提示代验。T15仅整合正式本地包、固定最终发布签名/构建身份和交付材料，并对发布构建重验受影响接口，不是T02获得真实认证的隐藏前置。

T02可用已安装并已核对的本机Apple开发工具链构建最小原生验证包，使用macOS本机ad-hoc代码签名（例如系统codesign的ad-hoc身份），Node固定其绝对路径、产物SHA-256及本次CodeDirectory身份；该方案不要求先购买Apple Developer账户或假定存在Developer ID证书。构建前登记实际工具链/OS版本与签名输出，在本机真实执行Keychain新增/读取/更新/删除、OS授权拒绝/取消与LocalAuthentication deviceOwnerAuthentication；访问控制若因本地重签改变须重新明确确认，不能静默放宽权限。此构建须标“仅本机verification用途”，不宣称Gatekeeper广泛发行认可、Developer ID签发或公证完成。工具链、helper或系统认证不可用就保持管理/凭证相关能力fail closed，不能降级默认口令或明文key。

T15再按实际分发范围明确最终签名方式、可获得的签名身份/证书和是否需要公证；没有实际证书/签名产物就记录未具备，不把本机ad-hoc验证冒充对外可信签发。本ADR当前未读取证书、未构建/签名helper、未做本机认证验证，亦不由此授权购买账户。

S09最近再认证的“配置供应商凭证”只发供应商枚举和一次性动作ID；Node启动受控helper原生安全输入窗，key从原生窗口直接进Keychain，不进入浏览器DOM、请求体或响应。Node取用时通过固定helper绝对路径、固定操作白名单及匿名stdin/stdout管道读取必要key到主机内存；禁止shell、`security -w <key>`、argv/env传key及通用命令拼接。helper只响应父进程发行的一次性动作nonce；stdout被专用解析器消费，不接通用日志，stderr只返回固定错误码。Node不持久明文、不记录请求Authorization头，使用后尽力清Buffer。

Keychain未解锁、条目不存在、helper缺失/签名不符、读取超时/拒绝一律`credential_unavailable`，AI关闭并提供手动创作；禁止回退.env、JSON明文、浏览器key或假配置成功。其他OS在有同等级已验收适配前不支持供应商凭证配置；手动功能仍可用。S09只返回configured/unavailable、供应商名和非秘密credentialRef，不回传key、截断key或可用于认证的摘要。

## 6. Reset、清除和最小审计

“忘记口令”仅给本机恢复说明。获准成人在原生启动器选明确的“重置成人认证”，由签名原生helper使用系统LocalAuthentication完成deviceOwnerAuthentication并展示影响确认；取消、不可用或认证失败均拒绝reset，不能降级成点确认即可。reset不通过浏览器、开放HTTP、默认密码或旧session执行。Node先关发送门、终止未提交AI、撤所有管理session/grant，再持久递增credentialEpoch并置recovery_required，原生窗口建立新口令后才完成。失败保持锁定，可重试；不能恢复旧session。供应商key默认保留但保持停用，只有另行明确“删除供应商凭证”才删Keychain条目；reset不清费用账本或作品。

### 6.1 工作区清除必须独立成人批准

S08仅可显示“申请清除此工作区”及影响范围，不拥有workspace-wide clear权；该范围含全部profile，普通profile无论是否writer均不得直接清除。申请产生非秘密operationId与原S08返回context，转到**独立adult-origin的受限`/clear-confirm`确认面板**；这里仅有本次影响、重新认证、确认/取消，不开放S09菜单、供应商/额度/AI管理入口。此路径是针对不可逆数据动作的受控成人确认，不改成从S08进入通用成人管理。未经成人重新认证不得读取其他profile的内容或详细清单；学生端只显示范围概述。

成人必须在本次确认面板重新输入管理口令，适用同一真实KDF与限流；既有管理cookie、5分钟新鲜session或客户端成人布尔均不能免掉此次重新认证。Node成功后仅在内存发行单次能力，字段冻结为`{capabilityId,action=clearWorkspace,workspaceId,generation,operationId,payloadDigest,adultSessionIdHash,credentialEpoch,serverEpoch,issuedAt,expiresAt}`，`expiresAt-issuedAt<=60秒`。payloadDigest由Node规范化本次明确确认的清除范围（workspace、generation、allProfiles、作品/快照/自动点/偏好等集合及范围版本）计算，不信客户端摘要。能力不是通用管理权限，不返回浏览器、DOM、URL、local/sessionStorage、作品或日志；浏览器只POST非秘密operationId与CSRF。能力不跨操作/工作区/代数/请求负载复用。

Node在准入与C1提交阶段均重查真实成人会话/重新认证绑定、credential/server epoch、60秒到期、当前generation、operationId/payloadDigest/action及未消费状态。普通profile、成人已退出/过期、旧generation、同一能力并发使用、已消费操作的重复提交、换payload均拒绝零新增清理写；已完成operationId的查询只返回原回执，不重复删除。确认前取消/离开使能力作废并返回S08原清除控件，作品/代数/租约零清理写；正常认证限流与安全审计除外。来源失效回S08标题并说明，不进入另一workspace。

### 6.2 消费、C1/C2与故障恢复

CommandQueue先同步reserve该能力防并发；外部准备不占用await队列。在C1发出提交决定前的最后同步闸门再次重查第6.1节全部条件并批准这一精确operation；随后C1在workspace数据库**同一事务**写`clear_journal`的非秘密capabilityId/operationId/payloadDigest/授权绑定/consumed记录、`workspaceGeneration g→g+1/lifecycle=clearing`及租约撤销屏障。能力消费的持久线性化点就是C1事务提交，不能先回成功再单独写generation。authority库与workspace库不做伪跨库原子提交，journal不存原始能力秘密。

C1最终准入前取消零清理写；已作出C1提交决定后，浏览器关闭、logout或会话随后到期不能要求Node假回滚这一已获准的数据动作。C1成功后由Node拥有C2删除及恢复责任，C2根据持久journal授权绑定和已准入状态继续，不要求60秒能力在整个删除/重启期间保持有效。C1确定失败使本次能力永久作废，须成人重新认证新操作；C1结果未知先查journal，不重发相同清除。重启不复活任何内存能力，仅凭已持久journal继续同一已获准清理。

C2是完整清理过程，必须依次包含：①数据库删除选定workspace全部profile及作品/快照/自动点/偏好，journal记`db_deleted`但仍`lifecycle=clearing`；②按Node持有的可信清单实际清除应用迁移备份及相关文件，不能仅删清单或假定备份不存在；③`C2-final`最终元数据事务提交`journal=deleted`、最终无内容clear tombstone及`lifecycle=active`。三者齐备才完成，不能以DB删除提交冒充整项成功。不能擦authority verifier、Keychain或费用账本；外部下载/教师/供应商副本仍按告知另列。

C1后任何C2步骤失败、备份/文件残留或中断都保持clearing只读/导出，不发行writer、不回空S00、不发新会话；可导出的仅是仍实际可访问材料，不能补造已删内容。C1失败也不自动恢复旧令牌，显式重新进入先核无未决clear。UI查询Node原operation状态，只有实际C2-final完成才显示“已清除”并允许空S00/新会话；中断/未知不得显示取消成功或内容已恢复。审计仅事件类型、时间、非秘密ID/epoch、拒绝原因、操作结果；无口令、nonce、cookie、供应商key、真实身份或AI正文。

## 7. 采用与验收边界

推荐采用DG03真实Node口令方案及DG02会话/关闭规则；DG01 Node存储改变C17数据位置，DG01/DG03还须明确采用“workspace-wide clear须成人本次重新认证＋单次精确动作能力”的权限改变及受限adult-origin确认路径，并修订C17/S08清除告知后实施。不能把学生原设置按钮直接升级成可删除全部profile的权限。未来R1-T02至少覆盖：首次并发bootstrap/过期重放、错误限流重启、直调/异源/过期/logout、每种AI未提交态撤权/迟到、reset中断、Keychain缺失拒绝、跨profile/workspace访问、clear普通profile/过期/换payload/并发/60秒/提交未知/重启续清、无秘密DOM/URL/受控日志检查，以及T02本机验证helper可独立构建/实际调用、身份不符拒绝且不依赖T15或未定付费账户。所有实际结果当前均`not_executed`，非执行审阅用例见相邻合同JSON。

## 来源

- 本vault `09_R1正式产品界面与功能工程计划_评审稿/P01_S00–S09页面与业务跳转工程案.md` §2.2/S07–S09/DG02–03；P03 §2/4/5/6；工程任务R1-P02、T02。
- `06_v3.0平台与AI详细设计_评审稿/R00_设计基线与跨案合同.md`；C13“成人控制与离线/availability”；C17“四类范围/三种权责/数据清单/退出清除”。
- [Node 24.21.0 crypto官方文档](https://nodejs.org/download/release/v24.21.0/docs/api/crypto.html)：scrypt及参数、随机盐、timingSafeEqual；精确对应冻结版本，不以latest-v24页面的后续24.x版本替代。这里只引用API能力，参数与会话期限是本ADR的工程推荐，不冒称官方认证或已实测。
- [Apple Keychain Services](https://developer.apple.com/documentation/security/keychain-services)、[SecItemAdd](https://developer.apple.com/documentation/security/secitemadd(_:_:))、[deviceOwnerAuthentication](https://developer.apple.com/documentation/localauthentication/lapolicy/deviceownerauthentication)：系统凭证/本机认证接口索引；具体helper设计是本ADR建议，尚需实现/签名/验证。
- [Apple Code Signing Requirement Language](https://developer-rno.apple.com/library/archive/documentation/Security/Conceptual/CodeSigningGuide/RequirementLang/RequirementLang.html)、[macOS发布签名](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/)：本机ad-hoc伪身份与正式分发签名分别核对；本ADR未证明当前机器具备工具链、任何证书或已签名产物。
