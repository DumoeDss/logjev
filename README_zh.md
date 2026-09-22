# LogJev

核心功能：把**普通 LLM** 桥成 **Jev systemone API**——任何 OpenAI 兼容 chat 上游，只要返回 `top_logprobs`，就能变成一个结构化决策服务（choice / score / noul 三原语，返回完整概率分布）。支持**文本、图片和音频输入**（`messages` 使用 OpenAI 风格的多模态部件；模型和服务端须同时支持对应输入模态与所需 logprobs）。上游相关的兼容性开关全部收敛在 `config.yaml` 的 provider 配置里。

**云端 API 和各种本地部署的 LLM 均可接入。** 下方列出的只是我们实测过的部分模型，不是支持白名单；其他模型只要其推理服务满足上述接口要求，同样可以使用。

中文 | [English](README.md)

本仓库为 **Node.js / TypeScript 实现**，适用于分类、路由、打分、过滤及其他答案空间有限的判断。支持多 provider、逐请求指定模型，以及官方 Jev 透传；上游密钥保留在服务端。

![2048 自动走子：棋盘、得分与模型方向概率实时更新](docs/assets/2048-autopilot.gif)

通过 Node 桥调用 `deepseek-flash` 的真实录屏：模型在合法方向中选择，棋盘、得分和概率条同步更新。这是短时玩法展示，不是游戏水平评测。[在本地打开试玩](http://127.0.0.1:8013/demos/2048/)。

## 实现原理

```text
POST /v1/systemone {state|messages, questions}
  → 为每道题单独塑形 chat prompt
    （choice → 字母标签，score → 档位下标，noul → 1–9 数字）
  → 读取首个 content token：max_tokens=1，temperature=1，
    logprobs=true，top_logprobs=topk
  → 过滤哨兵 logprob、合并重复标签、在合法标签上做受限 softmax
  → 从分布计算答案；忽略采样文本
```

| 原语 | 问题形式 | 返回 |
| --- | --- | --- |
| `choice` | 非空 criteria 对象，最多 **48 个候选** | 候选 key、全部候选的 probabilities、confidence |
| `score` | **2–10 档**有序列表 | 从 **0 开始**的档位概率加权均值、probabilities、confidence、legend |
| `noul` | 在 instructions 中描述一个是非命题 | 九档概率均值映射得到的 **0.01–0.99** 数值 |

- **一次正常边界读数请求 1 个输出 token**；重试会增加调用和 token。每道题单独携带完整上下文，同请求多问并不节省重复的输入 token。
- HTTP 默认使用 `full`：数据与指令边界、防注入提示、思考诱导和问题重复；`minimal` 使用更短的提示。可通过请求 `prompt_mode` 对照。
- 缺失 logprobs 时重读；合法标签全部缺席时用更强约束的提示重读。持续没有 logprobs 返回 502，不通过生成文本编造答案。
- **概率未校准**：桥接 `confidence` 等于候选最高概率，增删候选会改变归一化。阈值应在自己的业务样本上验证。
- `score` **可以是小数**；`noul` 没有独立 confidence。当前 chat 实现忽略 `noul.criteria`，判断边界应直接写进 `instructions`。

参考配置使用温度 1.0，以保留读数所需的概率分布。采样 token 不参与计算；温度 0 可能让上游返回的 logprobs 坍缩，破坏分布信息。

## 三个仓库

| 仓库 | 职责 |
| --- | --- |
| [logjev](https://github.com/DumoeDss/logjev) | Node.js 服务、TypeScript API、Fetch 标准处理器 |
| [logjev-py](https://github.com/DumoeDss/logjev-py) | Python/FastAPI 参考实现、评测和上游探测工具 |
| [jev-demos](https://github.com/DumoeDss/jev-demos) | 共享浏览器演示；两个后端以 `demos/` Git submodule 固定版本 |

两种实现均支持三原语、多模态和官方透传。Python 是 golden fixtures 的行为参考；Node 的提示词和分布数学通过离线对照检查。

## 从 npm 安装

需要 **Node.js 22+**。npm 包名为 **[@atelierai/logjev](https://www.npmjs.com/package/@atelierai/logjev)**，命令仍是 `logjev`。在新应用目录执行：

```powershell
npm install @atelierai/logjev@0.1.1
Copy-Item node_modules/@atelierai/logjev/config.example.yaml config.yaml
Copy-Item node_modules/@atelierai/logjev/.env.example .env
# Set provider keys in .env and choose providers in config.yaml.
npx logjev
```

包内包含编译产物、demos 和 skills；Bash 可将 `Copy-Item` 换成 `cp`。[GitHub v0.1.1 Release](https://github.com/DumoeDss/logjev/releases/tag/v0.1.1) 也提供同一份 `.tgz` 安装包。

## 从源码运行

```powershell
git clone --recurse-submodules https://github.com/DumoeDss/logjev.git
cd logjev
git submodule update --init --recursive
npm ci
Copy-Item config.example.yaml config.yaml
Copy-Item .env.example .env
# Set API keys in .env; select providers in config.yaml.
npm run build
npm start
```

以上复制步骤用于首次配置；已有 `config.yaml` / `.env` 时直接编辑现有文件。Bash 可用 `cp` 完成对应复制。

API 默认 **http://127.0.0.1:8013**，演示入口 **http://127.0.0.1:8013/demos/**。Python 版使用 8012，可同时运行。Node 会把自身地址注入页面作为默认 endpoint，自定义端口同样生效；用户保存的 endpoint 优先。

`npm start -- --config <路径>` 指定另一份配置，自动加载该 YAML 同目录的 `.env`，不覆盖进程已有环境变量。Node 不会自动读取相邻 Python 仓库的 `.env`；声明了 `api_key_env` 的 provider 在密钥缺失时会直接返回带配置提示的 503，不再发送无凭证请求。只需配置实际使用的 provider；无需认证的本地服务可省略 `api_key_env`。

以相邻目录 `LogJev-py` 为例，可显式共用现有配置和密钥：

```powershell
$env:PORT = '8013'
npm start -- --config ../LogJev-py/config.yaml
```

## 配置

配置结构沿用 Python 版的 `active`、`globals`、`providers`。完整模板见 [config.example.yaml](config.example.yaml)，两种 provider 的示例如下：

```yaml
active: deepseek
globals:
  port: 8013
  prompt_mode: full
  read_temperature: 1.0
  topk: 20
  concurrency: 4
  timeout_ms: 60000
  retry_delays_ms: [800, 2000, 5000]
  cors_origins: ['*']
providers:
  deepseek:
    kind: chat
    base_url: https://api.deepseek.com/v1
    api_key_env: DEEPSEEK_API_KEY
    model: deepseek-flash
    extra_body:
      thinking: {type: disabled}
  jev:
    kind: jev
    base_url: https://api.typesafe.ai/v1/systemone
    api_key_env: TYPESAFE_API_KEY
    model: jev-1.13
```

`kind: chat` 在 `base_url` 后追加 `/chat/completions`；`kind: jev` 使用**完整的官方决策端点 URL**，转发官方 payload。`api_key_env` 填密钥所在的环境变量名，不直接填密钥。provider 的 `topk` 覆盖全局值；`extra_body` 用于厂商专属参数，例如关闭思考。

| 设置 | 默认值 / 含义 |
| --- | --- |
| `active` | 默认 provider；请求的 `provider` 可选择其他已配置条目 |
| `globals.prompt_mode` | `full`；chat 请求中的 `prompt_mode` 可覆盖 |
| `globals.read_temperature` / `topk` | `1.0` / `20` |
| `globals.concurrency` | `4`；chat 问题的并发上限，在同一桥实例的多个请求间共享 |
| `globals.timeout_ms` | 每次上游尝试 `60000` ms；Node 版配置项 |
| `globals.retry_delays_ms` | `[800, 2000, 5000]`；重试临时网络错误及 429/500/502/503/504/529 |
| `globals.cors_origins` | `['*']`，也可指定允许的浏览器 origin 列表 |
| `floor_gap` | 历史字段；当前两种实现实际固定使用 **5**，配置值不参与计算 |

环境变量可覆盖 `PORT`、`HOST`（默认 `127.0.0.1`）、`LOGJEV_ACTIVE`、`PROMPT_MODE`、`BRIDGE_API_KEY`。provider 选择顺序为请求 `provider` → `LOGJEV_ACTIVE` → 兼容变量 `OPENJEV_ACTIVE` → YAML `active`。修改配置或 `.env` 后重启进程。

## HTTP API

| 端点 | 说明 |
| --- | --- |
| `POST /v1/systemone` | `{provider?, model?, state\|messages, questions, prompt_mode?}` → `{model, answers, usage, latency_ms}` |
| `GET /v1/providers` | `{active, providers: [{name, kind, model}]}`，不含密钥；供 demo 下拉使用 |
| `GET /v1/models` | active chat provider 的模型 ID 列表，默认模型排在前面；官方 provider 返回配置中的模型 |
| `GET /health` | `{ok, upstream, model, active, providers}`，不触发推理 |

设置 `BRIDGE_API_KEY` 后，决策请求必须携带 `Authorization: Bearer <key>`。Node HTTP 适配器限制请求体为 **16 MiB**。

上下文给 `state`（字符串或 JSON）或 `messages`（对话），两者不能同时传。消息角色支持 `system`、`user`、`assistant`；content 可以是字符串，或含 `text` / `image_url` / `input_audio` / `audio_url` 的非空部件数组。媒体输入按上游要求使用 user 角色。`questions` 必须为非空对象，每道题都需要非空字符串 `instructions`。

`model` 省略或为 `jev-latest` 时，使用所选 provider 的默认模型；其他字符串作为上游模型 ID。官方透传保留其 answers 和其他响应字段，补充桥端延迟，题型细节由官方 API 校验；桥的 `prompt_mode` 对其无效。

## 调用示例

### 文本判断

```bash
curl http://127.0.0.1:8013/v1/systemone -H 'Content-Type: application/json' -d '{"state":"The customer was charged twice.","questions":{"refund":{"type":"noul","instructions":"Does the customer need a refund?"}}}'
```

### Node.js 一次请求多个问题

直接使用内置 `fetch`，无需客户端 SDK。可保存为 `.mjs` 文件，或在 ESM 项目中执行：

```js
const endpoint = process.env.LOGJEV_URL || 'http://127.0.0.1:8013';
const headers = { 'Content-Type': 'application/json' };
if (process.env.BRIDGE_API_KEY) headers.Authorization = `Bearer ${process.env.BRIDGE_API_KEY}`;
const response = await fetch(`${endpoint}/v1/systemone`, {
  method: 'POST', headers, signal: AbortSignal.timeout(30_000),
  body: JSON.stringify({
    state: { ticket: 'I was charged twice. Please fix it before tomorrow.' },
    questions: {
      intent: {
        type: 'choice', instructions: 'What is the main customer request?',
        criteria: { refund: 'Refund or billing correction', tech_help: 'Technical help', other: 'Neither' },
      },
      urgency: {
        type: 'score', instructions: 'How much time pressure is explicitly stated?',
        criteria: ['No deadline', 'A future deadline', 'Immediate service disruption'],
      },
      has_deadline: { type: 'noul', instructions: 'Does the ticket explicitly state a deadline?' },
    },
  }),
});
if (!response.ok) throw new Error(`LogJev HTTP ${response.status}: ${await response.text()}`);
const result = await response.json();
console.log(result.answers, result.usage, result.latency_ms);
```

这里的 `LOGJEV_URL` 是**客户端约定**，不是服务端配置项。chat 响应会汇总成功读数返回的 `usage.input_tokens` 和 `output_tokens`。当前 `usage.reads` 是**问题数量，不是包含重试的 API 调用次数**。执行后续动作前应校验候选与概率分布。

### 图片判断

选择支持视觉的 chat provider，将以下 JSON 发到同一端点。图片 URL 替换为实际可访问的图片，或 `data:image/png;base64,...`：

```json
{
  "messages": [{"role": "user", "content": [
    {"type": "text", "text": "Inspect this screenshot."},
    {"type": "image_url", "image_url": {"url": "https://example.com/screenshot.png"}}
  ]}],
  "questions": {
    "has_error": {"type": "noul", "instructions": "Is an error message visible in the screenshot?"}
  }
}
```

图片部件保留在对话中，桥在末尾追加纯文本问题。视觉 demo 会发送实际棋盘 canvas 的 PNG，并展示模型收到的那张图片。

### 音频输入

音频直接进入模型上下文，桥不做转写或转码。按所选上游使用对应格式：

- `input_audio`：`{ "type": "input_audio", "input_audio": { "data": "BASE64_AUDIO", "format": "wav" } }`。`data` 填原始 base64，不带 data URL 前缀。[OpenRouter 使用此格式](https://openrouter.ai/docs/guides/overview/multimodal/audio)，不支持直接传音频 URL。
- `audio_url`：`{ "type": "audio_url", "audio_url": { "url": "data:audio/wav;base64,BASE64_AUDIO" } }`。这是已验证的 [NVIDIA Nemotron Omni](https://docs.api.nvidia.com/nim/reference/nvidia-nemotron-3-nano-omni-30b-a3b-reasoning) 格式。URL 类型和音频编码由上游决定，桥原样转发部件。

将以下 provider 合并到 `config.yaml`，在 `.env` 中填写 `NIM_API_KEY`；示例配置也已包含此条目：

```yaml
providers:
  nim-omni:
    base_url: https://integrate.api.nvidia.com/v1
    api_key_env: NIM_API_KEY
    model: nvidia/nemotron-3-nano-omni-30b-a3b-reasoning
    topk: 5
    extra_body:
      chat_template_kwargs: {enable_thinking: false}
```

准备实际的 `request.wav` 后调用：

```js
import { readFile } from 'node:fs/promises';

const audio = (await readFile('request.wav')).toString('base64');
const response = await fetch('http://127.0.0.1:8013/v1/systemone', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    provider: 'nim-omni',
    messages: [{ role: 'user', content: [
      { type: 'audio_url', audio_url: { url: `data:audio/wav;base64,${audio}` } },
    ] }],
    questions: { intent: {
      type: 'choice', instructions: 'What is the main request in the recording?',
      criteria: { refund: 'Refund or billing correction', technical: 'Technical support', other: 'Neither' },
    } },
  }),
});
if (!response.ok) throw new Error(await response.text());
console.log((await response.json()).answers.intent);
```

音频字段必须为非空字符串；桥校验结构，解码、编码格式及音频时长限制由上游负责。两种音频部件在每题提示词和重试中均保持原样。启用桥认证时，还需携带桥的 Bearer key。

**2026-09-22 线上实测**使用本地合成语音，决策请求不附带转写文本：

| 端点 / 模型 | 音频与 LogJev 结果 |
| --- | --- |
| NIM `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | **`audio_url` + 关闭思考可用。** Node、Python 均将两段录音分别判为退款 / 技术支持，并返回概率分布；Python 也验证了 `score`、`noul` 响应。 |
| OpenRouter `xiaomi/mimo-v2.6-pro` | 能转写和分类音频，但文本、音频读数均返回 `logprobs: null`，严格参数路由返回 404。**当前不兼容 LogJev 概率决策。** |
| OpenRouter `meta/muse-spark-1.3-contributor` | 完成账号年龄确认后，关闭推理返回 400；启用推理时厂商明确拒绝 logprobs。此外要求至少 16 个输出 token。**当前不兼容。** |

NIM 请使用实测的 `audio_url`：`input_audio` 对照请求未能正确转写录音。托管端点有时在 `max_tokens: 1` 下仍返回 2–3 个 completion token，计费应以实际 usage 为准。两条分类正确只证明链路可用，不代表通用准确率或概率已校准。两个 OpenRouter 路由均未验证出可用的音频概率决策；桥不会以生成文本替代缺失的 logprobs。

Node HTTP 请求体上限为 **16 MiB**，base64 编码会增加约三分之一体积；请据此限制录音大小。

### 错误处理

| 状态码 | 含义 |
| --- | --- |
| 401 | 桥自身的 Bearer key 缺失或错误 |
| 422 | JSON、provider、model、上下文、prompt mode 或题目格式错误 |
| 413 | 超过 Node HTTP 请求体限制 |
| 502 | 上游失败、重试耗尽、上游响应错误或没有 logprobs |
| 503 | 所选 provider 的密钥变量为空；配置环境变量或 YAML 同目录的 `.env` 后重启 |

最终的上游 429、401 等错误也会包装为 502，并带诊断信息，不原样透传 HTTP 状态码。`/health` 正常只说明配置已加载，不能证明上游密钥或 logprobs 可用。

## 三个 Demo

启动 Node 桥后打开 **[演示工作台](http://127.0.0.1:8013/demos/)**。`demos/` 是共享 `jev-demos` 子模块，使用静态 HTML/CSS/JavaScript 与本地字体，无前端构建步骤；Node 自动注入自身 API 地址。

| Demo | 输入与玩法 | 本地入口 |
| --- | --- | --- |
| [2048 自动玩](demos/2048/) | 文本棋盘状态；每步对合法方向发一道 choice 题，显示概率、选中方向和请求/响应 | [打开 2048](http://127.0.0.1:8013/demos/2048/) |
| [2048 视觉自动玩](demos/2048-vision/) | 只发棋盘 PNG 截图，不附文本牌面；可以核对图片输入和模型决策，要求视觉上游 | [打开视觉版](http://127.0.0.1:8013/demos/2048-vision/) |
| [书签整理器](demos/bookmarks/) | 导入浏览器书签 HTML、粘贴链接或载入示例，编辑分类后批量判断并复核低置信结果 | [打开书签整理器](http://127.0.0.1:8013/demos/bookmarks/) |

### 2048：规则归代码，选择归模型

两种 2048 都支持手动方向键/按钮、单步决策、自动运行和重置。代码先筛掉非法方向，模型只在可执行方向中选择；不是让模型判断移动是否合法。**Move interval 默认 As fast as possible**，即请求完成后不额外等待。Request / response，以及视觉版的 Image input，默认展开。

### 书签：批量分类与复核

点击 Example 可加载样例；也可导入自己的书签或文本链接。分类 rubric 可编辑，置信度 **低于 0.6** 的结果标记 review，同时显示 token 总量。Stop 等待在途请求结束后保留部分结果。0.6 是 demo 的交互策略，不是校准后的正确率保证。

### Compare：两套独立实例

**Compare 放在页面标题旁**。打开后 A/B 两列各有 provider、model、endpoint、prompt mode 配置；A 的已有棋盘/结果保留，关闭 B 会停止它的自动运行。可对比两个上游、模型，也可让两列分别连接 Node 8013 与 Python 8012。视觉版会过滤 demo 中的官方纯文本 provider。

工作台沿用 Cobalt Grid：纸色与钴蓝、本地字体、全宽桌面布局。桌面对比尽量在一个视口内完成主操作，长 JSON 在详情面板内部滚动；小屏恢复自然页面滚动。上游密钥不进浏览器，但输入材料仍会发往所选 provider 的上游。

### 独立启动共享前端

在 `jev-demos` 仓库或本仓库的 `demos` 目录执行：

```powershell
$env:JEV_ENDPOINT = 'http://127.0.0.1:8013'
node serve.mjs
```

独立静态服务默认端口 8099；未指定 `JEV_ENDPOINT` 时连接 Python 8012。浏览器已有的全局/实例 endpoint 设置优先于服务端默认值；旧 `openjev.*` 存储 key 保留兼容。demo 没有桥 Bearer key 输入框；启用 `BRIDGE_API_KEY` 时，应使用能携带认证头的客户端。

## 本地部署的模型

LogJev 没有 provider 或模型白名单。将 `base_url` 指向本机或内网的 OpenAI 兼容推理服务，`model` 填该服务实际提供的模型 ID。例如最小 `config.yaml`：

```yaml
active: local
providers:
  local:
    kind: chat
    base_url: http://127.0.0.1:8000/v1
    model: your-served-model-id
    topk: 20
```

服务无需认证时可省略密钥；需要认证时配置 `api_key_env`，将密钥写入 `.env`。`topk` 按服务支持的上限设置，关闭思考等模型专属开关放在 `extra_body`。

兼容性取决于**模型与推理服务的组合**：`/chat/completions` 须返回首个 content token 的 `top_logprobs`，且其中包含决策标签；只有 OpenAI 兼容 URL 还不够。图片、音频还需要服务支持对应输入。下面的表格只是已测试样本，没有列出的本地模型同样可以接入。

## 上游兼容性

上游需要 OpenAI 兼容 chat、返回**首个 content token 的 `top_logprobs`**，并允许该 token 是答案标签。思考型模型需通过对应 provider 参数关闭思考。

以下保留 **LogJev-py 在 2026-09 的探测记录**作为配置参考，并非 Node 版新一轮线上实测，也不保证模型目录当前仍然相同：

| 上游 / 模型 | 当时结果 | provider 配置 |
| --- | --- | --- |
| DeepSeek `deepseek-flash` 直连 | 可用，支持图片 | `extra_body: {thinking: {type: disabled}}` |
| OpenRouter `qwen/qwen3.8-27b` | 可用，支持图片 | `extra_body: {reasoning: {enabled: false}}`，`topk: 5` |
| OpenRouter `qwen/qwen3.8-flash` | 可用，支持图片 | 同上，`topk: 5` |
| OpenRouter `deepseek/deepseek-v4.1-flash` | 可用 | OR 的 reasoning 开关，`topk: 20` |
| NVIDIA NIM `google/diffusiongemma-26b-a4b-it` | 可用 | 当时探测不需要关闭思考 |
| OpenRouter `z-ai/glm-5.3-flash` | 不兼容 | 当时强制 reasoning，且无 content logprobs |

参考 Qwen 路由的 `top_logprobs` 上限为 5。OR 同模型可能切到不同后端，重读只能缓解偶发丢 logprobs，无法修复模型本身不兼容；探测中的 OR DeepSeek 路由使用统一 `reasoning`，而不是直连厂商的 `thinking` 参数。

接入新上游时，在配置中添加 provider，密钥放 `.env`；使用相邻 Python 仓库的探测器检查 thinking/topk 支持。探测器读取的是 **Python 仓库配置**；直接传端点可避免与 Node 配置混淆：

```bash
cd ../LogJev-py
uv run python probe_upstream.py --provider openrouter --models qwen/qwen3.8-27b
uv run python probe_upstream.py --base-url https://api.deepseek.com/v1 --api-key-env DEEPSEEK_API_KEY --models deepseek-flash
```

## 参考评测与成本

以下是 **Python 实现的历史实测**，取自 `LogJev-py/README_zh.md`（2026-09，authored144）。chat 行为 `full` 提示词，官方行使用原生 Decisions API。Node golden tests 验证覆盖样例中的提示词/分布行为，不代表已实测线上准确率、延迟或账单。

| 模型 | 准确率 | family bal. | P50 | 输入 $/M tok | 输出 $/M tok | 每题输入 tok | 整轮 144 题 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| DeepSeek `deepseek-flash` 直连 | **96.5%** | 96.8% | ~0.5s | $0.15 谷 / $0.30 峰 | $0.60 / $1.20 | 175 | ~$0.0040 / $0.0081 |
| 官方 `typesafe/jev-1.13`（OR Decisions） | **97.2%** | 97.1% | **0.49s** | $0.042 | $0 | 371 | **$0.0022 实付** |
| OR `qwen/qwen3.8-flash` | 87.5% | 87.4% | 1.07s | $0.15 | $0.47 | 203 | ~$0.0045 |
| NIM `diffusiongemma-26b-a4b-it` | 86.1% / 84.0% | 85.8% | ~1.5s | 当时免费档 | 当时免费档 | 189 | $0 |
| OR `qwen/qwen3.8-27b` | 77.8% | 79.6% | 0.84s | $0.20 | $2.50 | 236 | ~$0.0072 |

DeepSeek 行已用温度 1.0 重测。Qwen/NIM 为旧温度 0 的结果，**尚未按当前默认值重测**，不能直接当作同条件的最新排行榜；NIM 两个准确率反映两轮波动。早期“DeepSeek 与官方同分、各错四题”的描述属于旧 T=0 评测，不适用于这里的 96.5% 行。

价格只是当时快照，不是当前报价。桥接成本为实测 token × 当时报价，DeepSeek 按全部 cache-miss 计算；官方成本来自 `usage.cost` 实付。记录中的 DeepSeek 缓存命中输入价格为 $0.003/$0.006 每百万 token。chat 多题会重复 state，官方批量 API 的计费方式不同。探测和评测命令都会产生真实上游调用。

## 运行评测

数据和线上评测工具保留在 **LogJev-py**，两个实现共用同一套口径。三套数据来自 SemIf，来源和 manifest 见 Python 仓库的 `eval/data/README.md`：

| 数据集 | 行数 | 真值 | 测什么 |
| --- | --- | --- | --- |
| `authored144.jsonl` | 144 | 有 | evidence / rule / candidate 三家族 choice 准确率 |
| `perturbations108.jsonl` | 108 | 有 | 选项反转、标准包装、无关上下文等扰动稳定性 |
| `shape777.jsonl` | 777 | 无 | 跨系统 agreement 和置信度，不报告准确率 |

先让 Node 桥运行于 8013，再进入 Python 仓库执行：

```bash
cd ../LogJev-py
uv run python eval_compare.py --bridge http://127.0.0.1:8013 --data eval/data/authored144.jsonl --modes logjev/full,logjev/minimal --out eval_node_authored144.json
uv run python eval_compare.py --bridge http://127.0.0.1:8013 --data eval/data/perturbations108.jsonl --modes logjev/full,logjev/minimal --out eval_node_perturbations108.json
uv run python eval_compare.py --bridge http://127.0.0.1:8013 --data eval/data/shape777.jsonl --modes logjev/full,logjev/minimal --out eval_node_shape777.json
```

`--limit` 可先跑少量样例，`--model` 覆盖 active provider 的模型，`--pace` 控制请求间隔以遵守上游限制。provider 在启动桥时选定。上面显式的 `--modes` 只测指定桥；加入 `jev-1.13` 会调用评测器单独配置的官方参照端点。Node 的实际延迟、费用应另行实测。

## 作为 TypeScript / Fetch 组件使用

可从 `@atelierai/logjev` 导入 `createBridge`。核心不依赖 Node 专属模块；文件配置与 HTTP 适配器放在 `@atelierai/logjev/node`：

```ts
import { createBridge } from '@atelierai/logjev';

const handle = createBridge({
  active: 'local',
  providers: {
    local: { name: 'local', kind: 'chat', baseUrl: 'http://localhost:8000/v1', model: 'your-model' },
  },
});
const response = await handle(new Request('http://localhost/health'));
```

目前验证运行时是 Node。其他 Fetch 兼容运行时需要相应部署适配与验证，不能仅凭使用 Fetch 就视为已支持部署。

## 本地测试

```bash
npm test
# Regenerate only when deliberately updating reference behavior:
python test/generate-golden.py ../LogJev-py
```

测试使用模拟上游，没有推理费用。覆盖 96 组 Python 提示词、384 组概率结果、舍入边界、重复标签/哨兵过滤，以及多模态、重读、429/529、usage、全局并发、认证、CORS、YAML 配置和真实 HTTP/static 适配器。

任意 JSON 数字格式、数字形式对象键的排序可能存在 Python/JavaScript 差异；需要提示词逐字节一致时使用字符串 state 与具名 criteria。

## Agent Skills

[skills/jev/SKILL.md](skills/jev/SKILL.md) 是随仓库提供的可安装技能包，指导 agent 使用 Jev 式决策：三原语选择、问题构造、响应校验、置信门控、失败处理、批量调用和校准。附 [API 参考](skills/jev/references/api-reference.md)、[Node.js 集成模式](skills/jev/references/patterns.md)、[踩坑说明](skills/jev/references/pitfalls.md)。

选择需要的安装位置；已有同名 `jev` skill 时先检查内容，避免覆盖自己的定制：

```bash
# Claude Code: project-level
mkdir -p .claude/skills
cp -R skills/jev .claude/skills/jev
# Or Codex: personal
mkdir -p ~/.codex/skills
cp -R skills/jev ~/.codex/skills/jev
```

PowerShell 安装到 Codex 的对应写法：

```powershell
$skillRoot = Join-Path $env:USERPROFILE '.codex/skills'
New-Item -ItemType Directory -Path $skillRoot -Force | Out-Null
Copy-Item -LiteralPath ./skills/jev -Destination (Join-Path $skillRoot 'jev') -Recurse
```

之后可以说：“用 Jev 判断工单意图和紧急程度，不确定的交人工复核。”本 skill 默认连接 Node 8013，可显式指定 Python 8012；不需要把两个仓库的同名 skill 重复安装。skills 也会随 npm 包一起分发。

## 代码结构与限制

```text
src/jev.ts           提示塑形、题目标准化、logprob 解析、三原语分布数学
src/bridge.ts        Fetch handler、provider、重试、并发、usage
src/config.ts        YAML 与环境变量配置
src/server.ts        Node HTTP 适配器与可注入默认端点的 demo 托管
src/cli.ts           启动入口、配置选择、.env 加载
config.example.yaml provider 拓扑与全局参数示例
test/                Python golden fixtures 与模拟集成测试
demos/               共享 jev-demos Git submodule
skills/jev/          agent skill 及 API / patterns / pitfalls 参考
```

已知近似：缺失标签使用 `min(top_logprobs)-5` 下限；noul 是九档线性映射；没有噪声平均。被下限补出的分布不表示经过校准。Node HTTP 适配器用于本地 HTTP 服务，其他部署目标需要单独验证。

## 共享 Demo 与分发

先在独立 `jev-demos` 仓库提交 UI 修改，再推进并提交两个后端的 `demos` gitlink。每个后端固定一个 commit，不会随另一个后端静默更新。首次克隆使用 `--recurse-submodules`；三个远程仓库放在同一 GitHub owner 下即可沿用 `../jev-demos` 相对 URL。

`npm pack --dry-run` 可检查分发内容：编译产物、demos、skills、配置模板、双语 README。真实 `.env`、本地 `config.yaml`、日志和开发测试不进包。安装包及校验和见 [GitHub Releases](https://github.com/DumoeDss/logjev/releases)，版本记录见 [CHANGELOG.md](CHANGELOG.md)。GitHub 自动生成的源码压缩包不包含子模块内容；需要 demos 时使用递归克隆或 npm 包。
