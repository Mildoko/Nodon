---
adrVersion: nodon-r0-motion-evidence-adr@1
contractVersion: nodon-r0-runtime-contract@1
evidenceVersion: collect-chase-evidence@3
date: 2026-10-28
status: T00冻结候选；主实施者核准后供T02/T03编码
---

# R0 单tick运动与真实证据ADR

与`r0-runtime-contract.md`共用唯一产品根、来源编号、构建及审批状态。本页细化S01§3.1、S04 ADR-R0-02/03；保留C03/C07玩法、C08旧事件身份及J02映射，不修改旧@2/K03文件，不读取旧原型实现作为核心。

## 1 tick与原子提交

逻辑dt固定1/60；tick0为初态，首步attemptedTick=1。step只接受冻结RunState和显式方向，不读DOM/网络/模型/时钟/当前编辑Document。只有running能step；其余状态返回同动态内容且不造玩法事件。

一个tick依次：

1. 保存before_move；读取该tick实际方向，非零除以sqrt(x²＋y²)，零向量保持0。玩家意向end=start＋方向×160/60。
2. 守卫按ASCII id遍历；用before_move玩家−守卫向量平方距≤detectRadius²判断chasing。由非追逐变追逐发chase_started，反向发chase_stopped；持续状态不重复事件。chasing时朝该before_move玩家位置走speed/60，向量零则不移动；不追逐静止，无回巢。
3. 玩家与所有守卫各自意向end逐轴clamp至x[20,940]/y[20,520]；本tick路径恰为start到clamp后的end直线，不模拟碰墙后滑动分段。奖励start=end固定初始位置。动态坐标连续，无10u吸附。
4. 对尚未领取奖励按ASCII稳定id计算相对段接触；每接触先将ID加入临时collectedIds，产生reward_collected，再按类别当时分值产生score_changed，更新临时score。重复接触已领取ID不再生成事件/加分。
5. 若本tick有任何加分，只生成一次goal_checked，score取全部加分后最终值。goalReached仍按最终score≥targetScore计算，即使本tick没有goal_checked也不伪造检查事件。
6. 计算所有守卫相对段接触、timeout=timer.enabled && attemptedTick≥limit×60、win=goalReached。caught优先于timeout优先于win，最多一个round_ended；记录三个实际布尔值。两守卫接触保留全部，主定位仅ASCII首项。没有守卫时caught恒false、列表空、主ID=null，不借历史事件补当前caught。
7. 完整断言/每tick预算通过后一次提交nextState和全部临时事件，tick=attemptedTick。终局进入ended，随后任何输入不改变tick/位置/分数/领取集合。tick内即使早接触也按上述全tick顺序完成领取/优先级，不按tClosest重新排序或将运动截断到接触点。[C03/C07/S04-02]

每tick最多256事件；超出或算术/断言异常，整个临时状态和临时事件均丢弃，lastCommittedTick不变，run进入fault；单列诊断，不提交已暂算的领取/得分/终局。event序号只在完整提交时分配，不因失败留下伪事实。故障注入的非默认预算明确faultInjection=true，不能说18实体自然溢出。每run执行预算最多7200完整tick；若tick7200合法timeout/win/caught，先记录该合法终局；若仍running，预算终止为runner blocked，不能冒充玩家timeout。[S01/S04-02/04]

## 2 唯一扫掠算法与见证

对玩家P、目标Q：r0=P.start−Q.start，d=(P.end−P.start)−(Q.end−Q.start)，den=d·d。den=0取t=0，否则t=clamp(−r0·d/den,0,1)。m=r0＋t×d。令R=radius(P)＋radius(Q)，以m·m≤R²判contacted；恰等计入，无隐式epsilon/扩大半径。minCenterDistance=sqrt(m·m)，endpointCenterDistance=|P.end−Q.end|，contactThreshold=R，closestTickFraction=t。判定使用平方量，不用先四舍五入显示距离。任何中间量非有限值fault。显示舍入不回流判定。[S01§3.1/S04-02]

@3唯一`ContactWitness`形状：`{entityIds:[playerId,targetId],startPositions:{[playerId]:{x,y},[targetId]:{x,y}},endPositions:{[playerId]:{x,y},[targetId]:{x,y}},closestTickFraction,minCenterDistance,contactThreshold,endpointCenterDistance,contacted}`。实体映射恰含两个参与ID，坐标是该tick实际clamp路径起止。contacted布尔，fraction∈[0,1]，距离/阈值有限且≥0。序列化名字固定，不输出tClosest/t*/contactDistance别名。按target ID排列见证数组。[S04-03]

事件positions始终是其observationPhase的采样端点；after_move不代表“接触时位置”。需要接触时中心可从见证线性插值复算，不再加第二套可能不一致的contactPoint字段。发现用before_move平方距离；仅报告中心距和阈值，不推导墙/视线/路径。

## 3 @3事件公共字段及顺序

RunEnvelope有`evidenceVersion,runtimeVersion,ruleRegistryVersion,entityBudgetPolicyVersion,trialPolicyVersion,contractVersion,buildHash,runtimeArtifactHash,environmentId,runId,projectId,revision,semanticHash,evidenceSource,initialStateReference,inputSource,executionClass,inputsRef,truncation,events,diagnostics,finalStateRef`；普通run的trialPolicyVersion可保留固定策略版本而candidate字段为空，candidate run另有requestId/baseRevision/baseSemanticHash/candidateHash/candidateSemanticHash/trialId/scriptId/maxTicks/expectedAssertions/actualAssertions/coverage/uncovered/trialStatus/failureReason。source只为actual_author_run|machine_test|replay；合成参考使用独立历史读取入口，不能进入新@3实际run集合。[C08/S01§6]

每条玩法事件恰含C08公共字段：`eventId,runId,projectId,revision,semanticHash,tick,kind,entityIds,causeId,actualValues,ruleId,positions,observationPhase`。eventId=`<runId>:e<sequence>`，sequence从1单调；run_started是e1/tick0/before_move；同tick之后顺序为守卫追逐转换（ASCII）→奖励collect/score对（ASCII）→一次goal_checked（适用时）→一次round_ended（适用时）。entityIds去重ASCII排序，positions键恰与其相等；Witness中参与者顺序仍固定玩家先。causeId仅同run此前真实事件或null，不造“causeId=最近任何事件”的伪因果。删除实体不改历史ID/positions。[C08/S04-02]

各kind的actualValues固定为下列联合；不允许字段散装拼接：

- `run_started`：`{score:0,targetScore,timer:{enabled,limit},guardCount,rewardCount}`；entityIds为全部初态实体；ruleId=null，causeId=null，positions=初态。
- `chase_started|chase_stopped`：`{guardId,centerDistance,detectRadius,speed,chasing}`；entityIds为玩家＋该守卫；phase=before_move；chasing分别true/false；ruleId=`rule.guard.chase@1`；causeId=null。centerDistance是before_move的未舍入距离。
- `reward_collected`：`{rewardId,rewardKind:"normal"|"high",value,firstCollection:true,contactWitnesses:[ContactWitness]}`；entityIds为玩家＋该奖励；phase=after_move，ruleId=`rule.reward.collect@1`，causeId=null。唯一见证target必须该奖励且contacted=true。
- `score_changed`：`{rewardId,rewardKind,value,scoreBefore,scoreAfter,delta}`；delta=value，after=before＋delta；entityIds同前；phase=after_move；ruleId=`rule.reward.collect@1`，causeId为对应reward_collected。位置仍存采样副本，不指向当前状态。
- `goal_checked`：`{score,targetScore,passed,contributionEventIds}`；contributionEventIds为本tick全部score_changed ID按生成顺序；entityIds为玩家＋本tick贡献奖励，phase=after_move，ruleId=`rule.goal.score@1`；causeId指最后score_changed，仅表直接触发。passed=(score≥targetScore)，没有加分不生成此事件。[S04-02/03]
- `round_ended`：`{reason:"caught"|"timeout"|"win",result:"fail"|"win",score,targetScore,goalReached,caught,timeout,caughtByEntityIds,primaryGuardId,contactWitnesses,contributionEventIds,goalCheckedEventId}`。result仅win为win；其他fail。caughtByEntityIds为全部接触守卫ASCII排序，空则primaryGuardId=null，非空为首项；witnesses一守卫一份。contributionEventIds为本tickscore_changed ID列表；goalCheckedEventId为本tickgoal_checked或null。entityIds含玩家＋全部接触守卫，phase=after_move。ruleId按reason映射caught→`rule.contact.fail@1`、timeout→`rule.timer.limit@1`、win→`rule.goal.score@1`。caught/timeout的causeId=null（规则/几何是条件，并非此前某得分事件直接导致失败）；win的causeId指本tickgoal_checked。同tick达标又caught仍保存goalReached=true及达标事件。[J02/C08/S04]

上列事件细字段和因果空值选择是本页E01冻结默认。J07仅是@2合成终局摘录，@3不输出其含混contactDistance，也不把摘录标成实际run。run_fault不再混为@3玩法kind；旧@2读取器仍按历史合同处理旧run_fault。[S04-03]

## 4 诊断、截断及重放

诊断独立序列D：`{diagnosticId,runId,projectId,revision,semanticHash,buildHash,runtimeArtifactHash,kind,attemptedTick,lastCommittedTick,ruleId:null,observationPhase:"last_committed",positions,actualValues}`。run_fault的actualValues=`{code,message,faultInjection}`，positions是最后完整tick所有动态中心，绝不放失败临时位置；attemptedTick=lastCommittedTick＋1。performance_warning/暂停/通道守护/runner_budget单列诊断kind，不当游戏事件或AI事实前因。诊断文字清理内部秘密。[S01§3.1/S04-03]

环形玩法事件保留最近1000条，truncation=`{capacity:1000,totalCommittedEvents,droppedCount,firstRetainedSequence,lastRetainedSequence,droppedThroughTick}`，空时两个sequence和droppedThroughTick为null；后者有丢弃才填最后丢弃事件tick。totalCommittedEvents包括被丢弃事件，sequence不复用；可保留causeId指已丢弃事件但观察/发送明确missingCause，不补事件。实际导出保留该run环形范围及原始输入，不伪称全日志。超过1000的截断不等于该行为没发生；需完整因果链时重做短见证或报告缺证。[C08/S01]

重放使用不可变初态和Node实际消费逐tick输入，生成新runId/eventId，evidenceSource=replay。比较忽略runId/eventId绝对字符串并将causeId/贡献引用正规化为事件序号；保留tick/kind/ruleId/phase/实体/实际值/因果拓扑/终局。不要忽略revision/semanticHash/Runtime/构建身份，也不抹去原包。固定同artifact/环境下关键事件可复现；跨环境数值比较可在独立报告用明确容差，但绝不改变Runtime接触阈值。[C07/S01]

## 5 独立预期与必要真实路径

以下为实施前的独立数值预期，不是已执行结果。T02/03应保存实际值及第一分歧：

- 玩家(100,100)、输入(1,0)一步end=(102＋2/3,100)；输入(1,1)各轴增加160/(60√2)；零输入不动。玩家(940,100)右下输入，x夹至940，y增加160/(60√2)；路径为这两个实际端点间直线。
- 守卫(300,100)、玩家(120,100)、detect180恰等追逐；speed100向左一步至(298＋1/3,100)。距180＋正数立即不追。玩家在步末才进圈，该tick不提前追，下一tick才检查新before_move。
- 低层扫掠：P(0,0)→(4,0)，静Q(2,22)，两半径和22：fraction0.5，min22，endpoint√488>22，contacted=true；Q.y略>22则false。Q(2,0)时min0、fraction0.5；相对位移0时fraction0。低层轨迹不是编辑合法初态，不得冒称完整run证据；关键穿越/切线另用合法fixture真实step到达。
- 两奖励同tick：从score0起普通1/特别3均首次领取，按ID产生两组collect/score，最终score4、仅一次goal_checked；持续接触下一tick不再加分。若普通id在ASCII高值id后，事件顺序仍按ID，不按类别/碰撞时间。
- 计时15秒：停留且不提前终局，tick899无timeout，tick900才timeout；180tick冒烟不能见证该事实。
- 三判据用完整合法fixture与≥900tick实际输入得到上限tick同时得分达标/守卫接触：reason=caught，goalReached=true、timeout=true且达标事件保留；去接触另run→timeout；再关计时另run→win。不得直接把tick跳到899或复制K03事件作为实际证据。[S01 R0-RT-07]
- 在已暂算collect/score后注入预算/断言故障：提交tick/score/领取/事件均保持上一个完整tick，只有diagnostics.run_fault记录attemptedTick。两守卫接触：一次round_ended，双方ID及各自见证完整；0守卫run始终无chase/caught。

S01 R0-RT-01…18和T00 case-manifest才是执行清单；本页的数学预期不替代浏览器失焦、完整路线、真实模型或人工判断。E01细事件/诊断字段、E02环形截断元数据和E03合法预算终局先于runner_budget为直接编码默认，主实施者应与主合同D01–D12一起记录核准，不留实现时任选。
