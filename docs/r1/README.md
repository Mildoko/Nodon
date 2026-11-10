# R1 P00–P04 非编码准备包

2026-11-02；用户已采用r1-ui-plan.review.2，仅批准本轮非编码准备与复审。当前工程唯一根不变；本目录仅文档与不可执行设计/用例JSON。

阅读顺序：

1. [基线与资产](baseline-and-gap-register.md)、[资产台账](asset-register.json)。
2. [存储ADR](adr/ADR-R1-01-repository.md)、[事务合同](contracts/repository-schema-and-transaction.md)。
3. [成人认证ADR](adr/ADR-R1-02-adult-auth.md)、[投影与游标](adr/ADR-R1-03-projection-and-cursor.md)、[页面/命令/返回](contracts/page-command-and-return.md)。
4. [验收清单](acceptance/case-manifest.json)、[阈值和AI预算边界](acceptance/performance-and-ai-budget.md)、[证据模板](acceptance/evidence-template.md)。开发80与冻结20均只是合成输入/预期；sealed为流程隔离，未运行、未调试，不是加密封存。
5. [准入与待采用决定](entry-gates-and-decisions.md)、[准入登记](entry-gate-register.json)、[复审入口](plan-review-reference.md)。

DG01存储位置/工作区清理改变原C17，DG02页面状态及DG03成人方案均待明确采用。清全工作区须成人重新认证和单次动作授权；普通作者不能删除别的档案。R0真实双链/关键风险和G-E非开发者证据仍待补。

正式编码=false；产品/测试/浏览器执行=false；模型调用=0；凭证读取=0。所有T00–T17未执行。文档复审结论不能充产品验收或R0/G-E通过。
