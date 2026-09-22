# LogJev API 参考

## 端点和后端

Node 默认 `http://127.0.0.1:8013`，Python 默认 8012。以下是 Node 实现的行为。

| 端点 | 行为 |
| --- | --- |
| `GET /health` | 配置状态、active、model、provider 清单；不探测上游可用性 |
| `GET /v1/providers` | `{active, providers: [{name, kind, model}]}`；不含密钥 |
| `GET /v1/models` | active chat provider 的模型列表，默认模型优先；官方 provider 仅返回配置模型 |
| `POST /v1/systemone` | 类型化决策；设置 BRIDGE_API_KEY 后需要 Bearer 认证 |

`provider` 从配置中选择条目；省略时用 active。`model` 省略或为 `jev-latest` 时使用该
provider 的默认模型，其他字符串作为上游 model ID。

`kind: chat` 通过首 token logprobs 计算答案；`kind: jev` 向完整官方端点转发
model、questions 和上下文，不传桥的 provider / prompt_mode。answers、usage 与其他
响应字段保留，model 使用请求选定值，补充桥端 latency_ms。官方语义由所选端点决定。

## 请求结构

```json
{
  "state": {"ticket": "I was charged twice. Please fix it before tomorrow."},
  "prompt_mode": "full",
  "questions": {
    "intent": {
      "type": "choice",
      "instructions": "What is the main customer request?",
      "criteria": {"refund": "Billing correction", "tech_help": "Technical help", "other": "Neither"}
    },
    "urgency": {
      "type": "score",
      "instructions": "How much time pressure is explicitly stated?",
      "criteria": ["No deadline", "A future deadline", "Immediate service disruption"]
    },
    "has_deadline": {
      "type": "noul",
      "instructions": "Is a deadline explicitly stated? A request to respond soon without a deadline does not count."
    }
  }
}
```

- `instructions` 必须为非空字符串；questions 的 key 只用于关联答案。
- choice criteria 为 1–48 项对象；高基数应先预筛，top-k 之外的标签只能用下限近似。
- score criteria 为 2–10 档有序列表；返回值是 **0 起始下标**的加权均值，不是评级文本。
- chat 模式下 noul 只使用 instructions，忽略 criteria；不能把重要边界仅放在 criteria 中。
- `prompt_mode` 为 full/minimal，仅对 chat 生效；接口默认 full。

## 图片、音频与对话

使用 messages 替换 state，不同时传两者。合法角色为 system/user/assistant。
content 是字符串，或由 text/image_url/input_audio/audio_url 组成的非空数组。

```json
{
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "Inspect this screenshot."},
    {"type": "image_url", "image_url": {"url": "https://example.com/screenshot.png"}}
  ]}],
  "questions": {"has_error": {"type": "noul", "instructions": "Is an error message visible?"}}
}
```

示例 URL 需替换为真实图片，也可用 data URL。选支持视觉的 chat provider；不要假设所有
官方透传服务支持图像。Node HTTP 请求体上限为 16 MiB，base64 会增加体积。

音频部件支持两种形式，按上游选择，桥不互转、不转写：

- OpenRouter：`{"type":"input_audio","input_audio":{"data":"BASE64_AUDIO","format":"wav"}}`，data 不带 data URL 前缀；data、format 为非空字符串，编码支持范围由上游决定。
- NIM Omni：`{"type":"audio_url","audio_url":{"url":"data:audio/wav;base64,BASE64_AUDIO"}}`，url 必须为非空字符串；桥不下载该 URL。

音频随 history 原样进入每道题及重试，题目仍追加为文本。上游还须返回首 token top_logprobs。
2026-09-22：`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` 在关闭 thinking 后，两个后端实测通过音频分类；配置 `topk: 5`、`extra_body: {chat_template_kwargs: {enable_thinking: false}}`。
MiMo v2.6 Pro 能识别音频但返回 logprobs:null；Muse Spark 1.3 contributor 强制推理且拒绝该模式的 logprobs。不能对这两个路由用生成文本降级。详细配置和可运行例子见仓库 README。

## 响应语义

以下数字仅用于说明结构，不是一次实测推理：

```json
{
  "model": "configured-upstream-model",
  "answers": {
    "intent": {"type": "choice", "choice": "refund", "probabilities": {"refund": 0.8, "tech_help": 0.1, "other": 0.1}, "confidence": 0.8},
    "urgency": {"type": "score", "score": 0.9, "probabilities": {"0": 0.2, "1": 0.7, "2": 0.1}, "confidence": 0.7, "legend": {"0": "No deadline", "1": "A future deadline", "2": "Immediate service disruption"}},
    "has_deadline": {"type": "noul", "noul": 0.83}
  },
  "usage": {"input_tokens": 600, "output_tokens": 3, "reads": 3},
  "latency_ms": 800
}
```

chat 的 confidence = 候选最高概率；noul 无 confidence。usage 的 input/output tokens
汇总上游成功响应，包括成功重读；`reads` 当前等于问题数，不能反推实际调用次数。
latency_ms 从请求准备完成后开始计时，包括排队和上游阶段，不含客户端到服务端的网络耗时。

## Node.js 客户端

保存为 ESM 模块，例如 `jev-client.mjs`。这是服务端代码；不要将服务密钥打包到浏览器。

```js
export async function systemone(payload, {
  endpoint = process.env.LOGJEV_URL || 'http://127.0.0.1:8013',
  apiKey = process.env.BRIDGE_API_KEY,
  timeoutMs = 30_000,
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/systemone`, {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`LogJev HTTP ${response.status}: ${await response.text()}`);
  const data = await response.json();
  if (!data || typeof data.answers !== 'object' || data.answers === null || Array.isArray(data.answers)) {
    throw new Error('LogJev response has no answers object');
  }
  return data;
}
```

LOGJEV_URL 是该客户端的约定。客户端 abort 停止等待，不保证桥中已经发起的上游调用被取消，
也不撤销费用。服务端 timeout_ms 限制的是每次尝试，整体请求可能包含排队和多次退避。

## Choice 响应校验

校验全部候选，不只看 choice 字段。舍入会使概率和略偏离 1，并可能产生并列最大值。

```js
export function validateChoice(answer, criteria) {
  const keys = Object.keys(criteria);
  const probs = answer?.probabilities;
  if (!keys.length || !probs || typeof probs !== 'object' || Array.isArray(probs)) {
    throw new Error('Missing criteria or probabilities');
  }
  if (typeof answer.choice !== 'string' || !Object.hasOwn(criteria, answer.choice)) {
    throw new Error('Choice outside candidate set');
  }
  if (Object.keys(probs).length !== keys.length || keys.some(key => !Object.hasOwn(probs, key))) {
    throw new Error('Probability keys differ from criteria');
  }
  const values = keys.map(key => probs[key]);
  if (values.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) {
    throw new Error('Invalid probability');
  }
  if (Math.abs(values.reduce((a, b) => a + b, 0) - 1) > 0.02) throw new Error('Invalid probability sum');
  if (probs[answer.choice] < Math.max(...values) - 0.00001) throw new Error('Choice is not an argmax');
  if (typeof answer.confidence !== 'number' || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) {
    throw new Error('Invalid confidence');
  }
  return answer;
}
```

此函数也允许官方 confidence 与最高概率不同；它不证明语义正确。score/noul 应分别检查
有限值和所选后端定义的范围，不要把 choice 的 confidence 逻辑套到 noul 上。

## 错误和重试

| 状态 | 含义 / 消费方式 |
| --- | --- |
| 401 | 桥自身认证失败；修复客户端凭证，不自动重试 |
| 422 | 请求校验失败；修复输入 |
| 413 | Node 请求体过大；缩小图片或上下文 |
| 502 | 上游失败、重试耗尽、响应异常或缺少 logprobs；按业务失败策略处理 |
| 503 | 所选 provider 的 api_key_env 对应变量为空；在所选配置同目录的 .env 或进程环境补齐后重启，不自动读取相邻 Python 仓库的密钥 |

Node 桥在上游 429/500/502/503/504/529 或网络故障时退避，默认 800/2000/5000 ms。
上游最终 429/401 等会被包装为 502，不原样返回状态码。不要把每个 502 都解释成缺少 logprobs。
调用方不要无限叠加重试；缺少密钥、模型不支持 logprobs 等配置问题需要修复。
