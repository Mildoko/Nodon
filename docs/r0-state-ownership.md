# 状态所有权与验证路径

本页是T00工程映射；T01前尚无Runtime入口或产品可玩状态。

|需求|当前状态|唯一拟实施所有者|可观察验证|
|---|---|---|---|
|作品/数量/分值/语义摘要|冻结数据，未实现|Node ProjectStore＋CommandBus|T01完整副本/零写入/revision/undo/ID与黄金SHA|
|运行位置/领取/得分/tick/终局|尚未实现|同一纯Runtime，RunSession持有动态状态|T02固定输入/扫掠/三判据；T03重放|
|候选和试跑证据|只有冻结合成输入|Node候选管理＋TrialRunner调用同Runtime|T05同candidateHash/build及运行见证|
|输入/画面/焦点|尚未实现|浏览器输入暂态＋Canvas只读快照；Node调度权威|T04真实浏览器按键/失焦/分辨率/返回|
|AI授权/费用|发送未批准|同Node串行门与持久费用账本|T06发送/撤销/预留/幂等；T09竞态|
|恢复|R0只内存会话，非C09存档|当前Store保留与明确重开受控初态|REC01不伪称可靠保存；完整持久恢复留后期|

未来CLI入口拟src/host/cli.ts，最小面板由T04交付；实际入口路径与build在首次真实执行时记录。旧06 HTML/helper/SVG不成为代码依赖。/tmp仅待同步文件暂存，不在/tmp编译、运行或生成正式证据。
