# Node.js 集成模式

以下 JavaScript 片段使用 API 参考中的 `systemone` 和 `validateChoice`；业务动作函数由应用提供。
阈值是示例策略，需要在真实数据上验证。

## 1. 分类与置信门控

```js
const criteria = { refund: 'Refund or billing correction', technical: 'Technical problem', other: 'Neither' };
const result = await systemone({
  state: { ticket },
  questions: { intent: { type: 'choice', instructions: 'What is the main request?', criteria } },
});
const answer = validateChoice(result.answers.intent, criteria);
if (answer.choice === 'other' || answer.confidence < 0.6) {
  await escalate(answer);
} else if (answer.confidence < 0.9) {
  await queueForReview(answer);
} else {
  await routeToApprovedHandler(answer.choice);
}
```

应用决定阈值与动作，模型仅返回判定。chat 的 confidence 等于最高概率；它没有额外的
“独立校准置信度”。日志保留 provider/model、rubric 版本和结果，方便复测。

## 2. 多问题并行与投机调用

同一 state 下的问题互相独立，可同时问意图、明确截止日期与严重程度。不要让后一道题的
instructions 引用“第一题的答案”；依赖前一步结果的问题应分两次调用。

```js
const result = await systemone({
  state: { ticket },
  questions: {
    urgent: { type: 'noul', instructions: 'Is there an explicit deadline within one day?' },
    severity: { type: 'score', instructions: 'How much service disruption is reported?', criteria: ['None', 'Partial', 'Complete'] },
  },
});
const severity = result.answers.severity.score;
const urgent = result.answers.urgent.noul;
```

相关答案可能矛盾，按业务规则处理。chat 每题重复整个 prompt，默认并发 4；额外投机题会
增加 token 和排队延迟，不套用其他后端的“加题近乎免费”假设。

## 3. 按场景处理失败

| 场景 | 失败行为 |
| --- | --- |
| 决定是否执行有副作用的动作 | 不执行，或转人工确认 |
| 排序、推荐、预取 | 保留原结果或原顺序 |
| 工具输出裁剪 | 保留原始完整输出 |

超时、无网络、422、502、响应校验失败都应走明确错误分支。重试耗尽不产生假的概率结果。
在权限场景中，模型的高分不替代用户授权、确定性权限检查或参数校验。

## 4. 本地规则前置

先用代码完成日期比较、数值范围、必填字段、候选合法性等确定性判断，再让模型处理语义灰区。
例如 2048 由代码算合法方向，Jev 只选择移动；不要根据一个命令的字符串前缀判断它一定安全。

对风险信号，可把“是否涉及删除”“是否向外发送数据”拆成独立 noul，但这些只是辅助信号，
不能代替操作系统权限和动作解析。

## 5. 选择候选，取回原始对象

```js
const candidates = extractCandidateSpans(text);
if (!candidates.length) throw new Error('No candidates');
const criteria = Object.fromEntries(candidates.map((item, index) => [`span_${index}`, item.text]));
const result = await systemone({
  state: { text },
  questions: { pick: { type: 'choice', instructions: 'Which candidate is the requested address?', criteria } },
});
const answer = validateChoice(result.answers.pick, criteria);
const chosen = candidates[Number(answer.choice.slice('span_'.length))];
```

按有限候选 ID 取回代码侧对象，不将模型输出直接拼接为 shell、SQL 或任意可执行文本。
如果允许“没有匹配项”，加入明确 fallback 并单独处理；候选超过 48 时先预筛。

## 6. 批量调用与成本

每条数据构造自己的 state，并限制客户端并发，避免向桥瞬时排入几百个请求。

```js
export async function mapLimited(items, limit, work) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  let next = 0;
  const results = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      try { results[index] = { ok: true, value: await work(items[index], index) }; }
      catch (error) { results[index] = { ok: false, error: String(error) }; }
    }
  }));
  return results;
}
```

按成功响应聚合 input/output tokens；官方响应若提供 usage.cost，可单独记录实际费用。
没有 cost 时按所用 provider 的计费规则估算，并区分缓存命中、阶梯价格与失败请求。
`usage.reads` 不是重试计数；不要拿它乘单次请求价格冒充准确账单。

## 7. 输出裁剪与 agent 挂点

工具输出裁剪应保留可回取的原文，错误、diff、结构化诊断及不确定片段优先保留。
对每个片段单独给足判断上下文，避免只传一个片段编号、问题却没有指出该片段内容。
后端不可达时直接返回原文，不据此删除历史上下文。

在 agent 的工具调用前后或完成检查环节接入时，先确认该客户端确实提供所需挂点；
不要假设 Claude Code 和 Codex 的 hooks 名称/输入结构相同。代码提取“哪些检查通过、
哪些文件变更”的事实，模型只做语义比对；模型不重新计算测试结果，也不自行宣告任务完成。

## 8. 验证与校准

使用代表实际输入分布的有标签样本，统计准确率、各类召回、人工率和置信度分桶表现。
小样本结果只能支持有限结论；包括容易混淆、域外和阈值附近的输入，再用独立样本验证选出的阈值。

相邻 `LogJev-py` 的评测工具可直接指向 Node：

```sh
cd ../LogJev-py
uv run python eval_compare.py --bridge http://127.0.0.1:8013 --data eval/data/authored144.jsonl --modes logjev/full --limit 10 --out eval_node_trial.json
```

这里会发真实上游请求。仓库的 `npm test` 使用 mock，只验证实现行为，不能测线上质量。
shape777 没有真值，只可评估 agreement。锁定 provider/model、prompt、候选内容/顺序和阈值；
变更任一项后复测，并同时检查修复了哪些旧错误、引入了哪些新错误。
