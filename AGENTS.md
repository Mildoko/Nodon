# Nodon R0 implementation workspace

唯一产品代码根 /Users/dmy/Projects/Nodon-R0。用户2026-10-28确认R0计划，T00工程合同/用例/对照/环境冻结核验后按依赖编码；模型接入与费用留T06确认。不要读取密钥或发送模型请求。

权威计划在 /Users/dmy/Obsidian/ChandlerLee_Vault_Internal/AI游戏创作平台-Nodon/07_R0最小真实闭环开发计划_评审稿/P00_R0范围技术决策与执行总表.md，冻结工程合同在docs/，用例在verification/。Obsidian只放方案/实施记录，/tmp交付暂存不作为第二实现或运行根。

- 实施和独立复审使用GPT-6.1 Sol High，单文件单写者。
- Node唯一持有ProjectStore/CommandBus/RunSession/TrialRunner/authEpoch；浏览器只输入和绘制快照，不复制可写作品或Runtime。
- 不复用旧06设计原型helper作为产品核心。旧file原型浏览器执行拒绝不绕行；新R0服务/浏览器需实际允许环境。CLI通过不代替UI/真人/AI证据。
- 严格TS和Ajv输入校验；拒绝未知字段、非有限数、非法结构。全部作品命令先完整副本验证再原子提交。
- 运行、候选、原作品隔离；哈希、构建、版本、证据必须真实。执行后记录原始输入/产物/结果与范围，未执行不打勾。
- 使用CodeGraph做符号/结构/影响查询；文档字面才用rg/read。初始化已属于用户确认的T00计划；写后等索引更新再查询，不把索引当测试。
- 不提交/推送/部署；不要改无关文件。密钥/私人身份不进入源码或证据。

固定工具链：PATH=/opt/homebrew/opt/node@24/bin:$PATH，Node24.21.0/npm11.19.0，npm ci --ignore-scripts，npm run build/typecheck，npm test。环境与lockfile以docs/r0-environment.json为准；不能用系统Node26悄悄代跑。
