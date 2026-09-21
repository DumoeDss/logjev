---
name: jev
description: 使用 LogJev / Jev systemone 接口实现分类、路由、打分、过滤、候选选择、图像与音频判断；指导三原语选型、请求构造、Node.js 集成与置信门控。适用于用户要接入 Jev 决策服务的任务，不用于文本生成或代替代码进行算术验证。
---

# 使用 Jev 做类型化决策

本 skill 随 Node.js 版 LogJev 分发。Python 版使用同一接口，但默认端口不同。

## 选择后端与任务边界

优先采用用户指定的 endpoint、provider 和 model；未指定时检查本地 Node 桥
`http://127.0.0.1:8013/health` 与 `/v1/providers`。客户端可约定 `LOGJEV_URL`，它不是服务端配置变量。
Python 桥默认 8012；按用户配置显式选择。不要因本地不可达而自动改用另一个云 provider。

Node 启动：在仓库中完成配置和构建后运行 `npm start`，或
`npm start -- --config /path/to/config.yaml`。加载的是该 YAML 同目录的 `.env`。
配置了 `BRIDGE_API_KEY` 时，POST 带 Bearer 认证；上游密钥只留在桥的配置环境中。
健康检查不发推理请求，不能证明上游密钥和 logprobs 可用。

Jev 选择有限答案；文本生成交给生成模型，合法性、算术和后续动作归代码。
对分类输入可能超出类别集的任务加入 `other` / `none_of_the_above`。
对已由规则穷举的合法动作集（例如 2048 合法方向），按业务定义选择，不强加不可执行的兜底选项。

## 三原语

| 原语 | 输入 | chat 桥的输出 |
| --- | --- | --- |
| `choice` | 非空 criteria 对象，最多 48 项 | choice key、候选概率、confidence |
| `score` | 2–10 个由低到高的 criteria 档位 | 从 0 开始的概率加权均值，可为小数；附 legend 和概率 |
| `noul` | instructions 中明确的是非命题 | 0.01–0.99；无独立 confidence |

`instructions` 必须是非空字符串。chat 桥当前忽略 `noul.criteria`，把正反边界写进 instructions。
`confidence` 是候选最高概率，未校准；不能当成正确率或执行许可。
官方 `kind: jev` 的 answers 保持其原始含义，不应套用所有 chat 数学规则。

## 构造与消费请求

1. state 放材料，instructions 放判断，criteria 放候选。question key 仅用于匹配响应，不参与 prompt。
2. 文本/JSON 用 `state`；对话、图片或音频用 `messages`，两者不同时传。上游须同时支持该模态和首 token logprobs；云端与本地服务都可接入，README 的实测模型不是白名单。
3. instructions 自包含，措辞中性；多问题彼此独立，不假设能读到同请求其他问题的答案。
4. 逐数据项构造上下文；避免把一批互不相关的数据塞进一份 state。
5. 校验响应类型、候选键集、有限数值、概率和及 argmax，之后再按业务阈值处理。
6. 置信度不足、超时和错误按预先确定的策略回落，不伪造分布，不重复调用直到得到满意答案。

chat 桥每道题都单独携带完整 prompt；默认最多 4 道并行，超出会排队。
`usage.reads` 当前等于题数，不统计重试；token 汇总包含成功重读返回的 usage。
换 provider/model、prompt 或候选集合后，用业务样本重新验证阈值。

音频使用上游支持的 `input_audio: {data: "原始 base64", format: "wav"}` 或
`audio_url: {url: "data:audio/wav;base64,..."}` 部件，type 与字段名一致，媒体放 user 消息。
NIM Nemotron Omni 已验证 `audio_url` + `chat_template_kwargs: {enable_thinking: false}`；
OpenRouter 使用 input_audio，但 MiMo v2.6 Pro / Muse Spark 1.3 contributor 当前不能返回所需 logprobs。
不要把“能听懂”当成“兼容概率决策”，也不要用转写或生成文本伪造概率。

## 深度参考

- [API 参考](references/api-reference.md)：请求/响应、图像与音频、错误语义、可复制的 Node fetch 与响应校验。
- [集成模式](references/patterns.md)：置信门控、批量、规则前置、候选选择、失败策略和评测流程。
- [踩坑说明](references/pitfalls.md)：温度、top-k、计费、舍入、跨语言差异与历史评测口径。
