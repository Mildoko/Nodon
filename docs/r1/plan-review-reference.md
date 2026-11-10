# P04 准备合同复审入口

本轮用户已采用R1计划并授权P00–P04文档准备，禁止正式编码。来源为vault/09既有计划；本轮执行摘要在vault/10_R1非编码准备与准入记录。独立审阅使用GPT-6.1 Sol High，作者单写文件；编制与审阅不冒充产品实测。

- 产品/基线/验收汇合：主agent。
- Repository：r1_storage_prep（Sol 6.1 High）。
- 成人认证/页面/投影：r1_auth_route_prep（Sol 6.1 High）。
- 独立复审：r1_prep_independent_review（Sol 6.1 High），只写review/independent-review.md和issues.json；作者修正后由原审阅者复核。

独立发现、修改位置、原人关闭证据见[报告](review/independent-review.md)与[问题清单](review/issues.json)。文档静态校验及输入不变检查见review/document-validation.json、source-integrity-before.json、source-integrity-after.json；本轮交付文件指纹见review/delivery-manifest.json（不对自身作循环hash）。

逐任务证据见review/preparation-task-results.json。P00–P04的16条局部文档切片与产品UX/NAV/X分层记录；任务文档通过不把任何产品运行验收改为通过。任务起点未逐个实时采样则actualStart/Duration填null并说明，不用mtime推算；实际完成/复核时间如实记录。

G-PLAN已采用且限P范围；G-R0未通过、G-E未验、G-ADR待采用；AND总门未通过，编码授权保持false。DG01/02/03明确决定后仍需相应实际证据；DG04新模型预算必须真实请求前核准。外部工具skip已确定，不重复要求操作，也不记通过。
