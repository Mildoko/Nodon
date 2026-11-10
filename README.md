# Nodon R0

唯一实现根：`/Users/dmy/Projects/Nodon-R0`。用户已确认review.4和R0计划，按依赖开始编码。

当前完成T00冻结、T01–T03基础，以及T04最小Canvas技术范围和T05受控候选确认门。最终构建7f9533356b2c，Node24 strict编译及221/221回归通过；实际T05套件14/14，浏览器真实键盘得到win@427，最终13个真实run包审计通过。T06离线门禁和唯一真实只读DeepSeek ACCESS探针通过；整轮额度20人民币，当前仅1attempt，按峰价usage估算0.00604元、保留0.056768元预留，账单待核对。

当前Web候选明确是controlled_fixture，不是模型输出。T04技术范围与T05已独立复审；T04关联T10-A真人比较仍缺证，T04整项、真实AI创作/排错双链及R0整体未通过。未接儿童/机构材料，未提交、推送、部署或招募。

## 本机运行

```sh
cd /Users/dmy/Projects/Nodon-R0
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
npm run build
npm test
node dist/src/host/cli.js verify --case R0-RT-07
node dist/src/host/cli.js audit --run /Users/dmy/Projects/Nodon-R0/evidence/r0/a29f25dcd468/04_runs/3b8dfa42-88ea-4198-806f-7310baa2d93c
```

Node24.21.0/npm11.19.0、TS5.9.3、Ajv8.20.0均精确锁定；禁止用系统Node26替代。更多完整命令与真实包路径见`docs/r0-cli.md`。

## 身份与证据

合同及环境在docs/，冻结期望在verification/，完整构建/原始日志/实际包在evidence/r0/。首批结果见`evidence/r0/a29f25dcd468/00_manifest/first-implementation-result.json`；测试中的合成指纹、mock响应、真实CLI和真实模型严格分列。

`.local/`与evidence输出被Git忽略以保护私有定位/账本及构建稳定性，文件仍本地保留。没有密钥复制进项目；凭证由主机回调按授权只读现有DeepSeek单变量，不进入模型输入、日志或浏览器。

## T04 / T05实际工作台

```sh
cd /Users/dmy/Projects/Nodon-R0
/opt/homebrew/opt/node@24/bin/node dist/src/host/web-server.js --port 4180
/opt/homebrew/opt/node@24/bin/node dist/tools/t05-verification.js
```

先完成严格编译；服务只监听127.0.0.1，端口0可分配新端口。`--verification-mode`仅额外开放明确标注的连接故障注入。Canvas不计算游戏规则；一个Node Host/Store/queue持有事实。内存作品刷新保留、进程重启回受控初态，没有产品保存。实际开发服务本轮位于http://127.0.0.1:52304/；端口仅在当前服务存活时可用。

入口合同：docs/r0-web-contract.md、docs/r0-t05-candidate-contract.md、docs/r0-ui-walkthrough.md。实际结果与独立关闭记录见docs/r0-t04-t05-result.md，以及evidence/r0/7f9533356b2c/10_decisions/。79份CUA原件分早期/最终构建；成熟工具机器准备不能替真人无AI对照或教学验证。
