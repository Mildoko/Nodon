# P03 证据封套与操作记录模板

版本r1-evidence-envelope@1。以下是空字段定义与未来步骤，未执行产品操作；不存在“模板已通过”即产品通过。

每条封套必须登记：recordId；taskId；UX/NAV/X/slice/专项ID；recordKind（design_reference / document_check / controlled_fault / program_execution / machine_browser_input / real_provider / developer_human / independent_nondeveloper / peer_human / human_judgment）；实际起止时间和时区；纯操作耗时（未计则null）；参与者匿名编号、经验、实际角色、操作/支持/见证者；OS/设备/浏览器与视口及DPR/字体/缩放；唯一工程根；buildHash/runtimeArtifactHash/合同/目录/规则/trialPolicy版本；workspaceGeneration、serverEpoch、projectId/revision/semanticHash、runId或比较侧snapshotId、requestId/candidateHash（不适用null及原因）；前置、步骤、独立预期、实际、状态；原件绝对路径与sha256；局限、缺失、失败与复核者/复核结论。

**状态**：未执行/通过/失败/阻塞/不适用。未测不填通过；不适用附预先理由；失败/取消/超时留原分母。没有输入证据，不根据屏幕动画反推“收到按键”。不能按文件mtime或聊天间隔倒推净耗时。

## 未来执行步骤

1. 先确认任务准入、已冻结预期/fixture/hash/最终构建。记录原件路径而非先建“通过”空目录。
2. 操作者按原步骤做，支持者每次提示逐条登记时间、内容、目的、是否代做。机器与人的输入不得混算；程序trace的human_keyboard标签本身不证明真人。
3. 记录动作前后Node收据/状态与UI反馈；截图只证明所示时点，滚动/焦点/取消需实际操作。运行包绑定该次实际run，旧tick导出不回填后续事件。
4. 非开发者验收需获准参与、实际经验/支持记录、明确作者自己的意图/决定/试玩/观察或未知；开发者或Agent不能代填。成人代理的可用性证据不外推儿童学习效果。
5. AI保存脱密请求/响应/usage/真实attempt/取消或超时与未知预留；人工独立核作者限制、operations和事实。原始模型自由文不自动作为儿童事实，语义结果不由模型自评。
6. 独立审阅者抽每类成功和关键失败，追到输入/命令/事件/费用/原件指纹。修订后关联新包，旧失败不覆盖。

## P00–P04本轮专用记录

recordKind=document_check；build引用7f9533356b2c仅作现状；产品/测试/浏览器/模型执行字段全部false；耗时为文档任务墙钟区间，非人类游戏操作耗时。文档检查证据保存docs/r1/review，既有evidence/r0不写入。本轮不生成evidence/r1假运行包。

## 基准与判断

AI价值基准只用Nodon手动规则卡/静态程序帮助（A04/C18），外部MakeCode已skip不重排。正式比较提前签任务变体、AB/BA交错顺序、经验与支持；先用开发集任务，不用冻结20调试。没有真实参与者，记录“待验”，不拿Agent秒数与人比较。收集意图保留、关键决定是否仍归作者、完成/未完成、耗时与提示、错误修复、实际成本；不以最终参数相等宣称教育增益。

## 文件清理与隐私

作品只包含C10允许数据。参与/支持/费用研究记录单独保存在有权组织者保管的材料位置，不进作品或AI输入。供应商key、成人口令、cookie、writerToken、完整本机路径不发模型、不进截图/导出/日志；本地证据中如需关联采用脱敏ID，敏感原件单独限权。清理作品不等于清理成人秘密/费用记录，需对应ADR告知。
