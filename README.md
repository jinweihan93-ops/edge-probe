# EdgeProbe

**On-device AI observability for iOS** — an OpenTelemetry-compatible SDK, a hosted trace viewer, and a CI regression detector.
**面向 iOS 的端侧 AI 可观测性**—— 一个兼容 OpenTelemetry 的 SDK、一个托管的 trace 查看器、一个 CI 回归检测工具。

[English](#english) · [中文](#中文)

---

## English

### What is EdgeProbe?

EdgeProbe gives you three things for AI features that run on the user's device:

1. **A Swift SDK** that traces LLM / ASR / TTS / embedding calls in one line.
2. **A hosted dashboard** that renders those traces as waterfalls, shareable via read-only public links.
3. **A CI benchmark harness** that catches latency and quality regressions before they ship.

Prompts and completions stay private by default. Public share links carry only timings and structure — never user content.

### The three-line install

```swift
import EdgeProbe

EdgeProbe.start(apiKey: "epk_pub_...")

try EdgeProbe.trace(.llm) {
    try model.generate(prompt)
}
```

That's the whole pitch. The SDK captures the span, exports it to the backend, and the dashboard renders a waterfall trace.

### See it live on a PR

EdgeProbe also ships as a **GitHub Action** for benchmark regressions. Three permanently-open demo PRs under [`examples/whisper-upstream-mock/`](examples/whisper-upstream-mock/) show the full rendered comment:

| Demo PR | What changed | What the EdgeProbe comment looks like |
|---------|--------------|---------------------------------------|
| `demo/first-run` | new project, no baseline yet | First-trace card, share URL, no regression math |
| `demo/regression` | `beam_size: 1 → 5` | **Red** — decode +4×, headline +114%, share URL |
| `demo/green` | `n_threads: 4 → 8` | **Green ✓** — encoder speedup, headline −18% |

The synth is deterministic, so every re-run of the same PR produces byte-identical numbers. See [`examples/whisper-upstream-mock/README.md`](examples/whisper-upstream-mock/README.md) for the math and the one-time commands to open the three PRs.

### Status

Year 2 P0 — initial scaffolding. The full plan is CONDITIONAL pending gating (see `docs/PLAN.md`).

### Project layout

| Path | What lives here |
|------|-----------------|
| `ios/` | Swift Package — EdgeProbe SDK (iOS 16+) |
| `ios/DemoApp/` | VoiceProbe — reference app exercising the full ASR → LLM → TTS loop |
| `ios/LlamaRuntime/` | Sibling SwiftPM package wrapping llama.cpp for simulator inference |
| `backend/` | Bun + Postgres — `/ingest`, `/r/{token}`, `/app/trace/{id}` |
| `web/` | Dashboard — `/app` |
| `harness/` | Benchmark CLI — `harness run` / `harness diff` (Y1 OSS tool) |
| `docs/` | Plan, design system, architecture notes |
| `scripts/` | Dev + CI helpers |
| `.github/` | Workflows (CI matrix across Xcode 16 / 16.1, coverage artifacts) |

### Quick start

```bash
# iOS SDK
cd ios && swift test

# Backend
cd backend && bun install && bun test

# Web
cd web && bun install && bun test
```

### Reference demo: VoiceProbe

`ios/DemoApp` is a full **ASR → LLM → TTS** voice loop with EdgeProbe wrapping each stage. The LLM backend has four paths depending on where you run it:

| Environment | Backend | Model | Download |
|-------------|---------|-------|----------|
| Device | MLX-Swift | Llama-3.2-1B-Instruct-4bit | ~700 MB |
| Simulator (default) | llama.cpp | Qwen2.5-0.5B-Instruct-q4_0 | ~428 MB |
| Simulator + `-EDGEPROBE_SIM_STUB` | Stub | deterministic canned reply | 0 |
| Simulator + `-EDGEPROBE_SIM_COREML` | CoreML | SmolLM2-360M-Instruct-4bit | ~210 MB |

First launch downloads the model from HuggingFace Hub; subsequent launches hit the on-device cache. Flip `-EDGEPROBE_SIM_STUB` when you need the demo to run offline or want to skip the 428 MB download.

Full setup, launch-arg reference, and the simulator-specific known issues are in **`ios/DemoApp/README.md`**.

### Documentation

- **`docs/PLAN.md`** — Year 2 P0 strategy, architecture decisions, review reports
- **`docs/DESIGN.md`** — color tokens, typography, components, forbidden patterns
- **`docs/SLICES.md`** — shippable slice log (what's done, what's next)
- **`docs/TEST-PLAN.md`** — testing strategy, critical regression paths

### Critical invariants (never regress)

1. Public share `/r/{token}` never renders prompt/completion text.
2. Cross-org trace ID scan returns 403, not 404.
3. Per-call `includeContent: true` does not escalate to public visibility.
4. Main thread is never blocked by the SDK.
5. SDK drops oldest span on buffer overflow; counter is emitted as a metric.
6. `EdgeProbe.start()` is idempotent.

### Advanced

- **Benchmark harness** — `harness/` is a separate SwiftPM package that runs prompts through the SDK in dry-run mode. Source of truth for the monthly benchmark posts, and doubles as an SDK integration smoke. CLI usage lives under `harness/`.

---

## 中文

### 这是什么？

EdgeProbe 为运行在用户设备上的 AI 功能提供三件套：

1. **Swift SDK** —— 一行代码即可追踪 LLM / ASR / TTS / embedding 调用。
2. **托管 Dashboard** —— 把 trace 渲染成瀑布图，可通过只读公开链接分享。
3. **CI 基准测试工具** —— 在发布之前捕获时延与质量回归。

Prompt 与 completion 默认保留在设备上。公开分享链接只携带时延与结构信息，从不包含用户内容。

### 三行代码接入

```swift
import EdgeProbe

EdgeProbe.start(apiKey: "epk_pub_...")

try EdgeProbe.trace(.llm) {
    try model.generate(prompt)
}
```

这就是全部。SDK 会捕获 span、上报到后端，Dashboard 自动渲染瀑布图。

### 在 PR 上直接看效果

EdgeProbe 同时以 **GitHub Action** 形式发布，用于基准回归检测。[`examples/whisper-upstream-mock/`](examples/whisper-upstream-mock/) 目录下有三个长期开着的 demo PR，可以直接点进去看 Action 渲染的 PR 评论长什么样：

| Demo PR | 改动 | EdgeProbe 评论效果 |
|---------|------|--------------------|
| `demo/first-run` | 新项目，尚无 baseline | 首次 trace 卡片 + 分享链接，不做回归比较 |
| `demo/regression` | `beam_size: 1 → 5` | **红** —— decode +4×，headline +114%，含分享链接 |
| `demo/green` | `n_threads: 4 → 8` | **绿 ✓** —— encoder 加速，headline −18% |

合成函数是确定性的 —— 同一个 PR 无论重跑多少次，数字都字节级一致。演算逻辑与一次性开 PR 的命令，见 [`examples/whisper-upstream-mock/README.md`](examples/whisper-upstream-mock/README.md)。

### 当前状态

Year 2 P0 —— 初始脚手架阶段。完整计划为 CONDITIONAL，等待 gating 触发（详见 `docs/PLAN.md`）。

### 项目结构

| 路径 | 内容 |
|------|------|
| `ios/` | Swift Package —— EdgeProbe SDK（iOS 16+） |
| `ios/DemoApp/` | VoiceProbe —— 演示完整 ASR → LLM → TTS 链路的参考 app |
| `ios/LlamaRuntime/` | 包装 llama.cpp 的 SwiftPM 包，用于模拟器推理 |
| `backend/` | Bun + Postgres —— `/ingest`、`/r/{token}`、`/app/trace/{id}` |
| `web/` | Dashboard —— `/app` |
| `harness/` | 基准测试 CLI —— `harness run` / `harness diff`（Y1 开源工具） |
| `docs/` | 计划、设计系统、架构笔记 |
| `scripts/` | 开发与 CI 辅助脚本 |
| `.github/` | Workflows（跨 Xcode 16 / 16.1 的 CI 矩阵 + 覆盖率 artifacts） |

### 快速上手

```bash
# iOS SDK
cd ios && swift test

# 后端
cd backend && bun install && bun test

# Web
cd web && bun install && bun test
```

### 参考 Demo：VoiceProbe

`ios/DemoApp` 是一个完整的 **ASR → LLM → TTS** 语音 demo，每一段都被 EdgeProbe 包裹成 span。根据运行环境，LLM 后端有四条可选路径：

| 运行环境 | 后端 | 模型 | 下载体积 |
|----------|------|------|----------|
| 真机 | MLX-Swift | Llama-3.2-1B-Instruct-4bit | ~700 MB |
| 模拟器（默认） | llama.cpp | Qwen2.5-0.5B-Instruct-q4_0 | ~428 MB |
| 模拟器 + `-EDGEPROBE_SIM_STUB` | Stub | 固定 canned 回复 | 0 |
| 模拟器 + `-EDGEPROBE_SIM_COREML` | CoreML | SmolLM2-360M-Instruct-4bit | ~210 MB |

首次启动从 HuggingFace Hub 下载模型，之后命中设备本地缓存。需要离线跑或想跳过 428 MB 首次下载时，加上 `-EDGEPROBE_SIM_STUB` 即可。

完整的启动参数、环境配置、模拟器相关的已知问题详见 **`ios/DemoApp/README.md`**。

### 文档

- **`docs/PLAN.md`** —— Year 2 P0 策略、架构决策、评审报告
- **`docs/DESIGN.md`** —— 颜色 token、字体、组件、禁用模式
- **`docs/SLICES.md`** —— 可交付 slice 日志（已完成 / 下一步）
- **`docs/TEST-PLAN.md`** —— 测试策略与关键回归路径

### 关键不变量（绝不回归）

1. 公开分享链接 `/r/{token}` 永不渲染 prompt / completion 文本。
2. 跨组织扫描 trace ID 返回 403，而不是 404。
3. 单次调用 `includeContent: true` 不会升级为公开可见。
4. SDK 永不阻塞主线程。
5. 缓冲区溢出时丢弃最旧的 span，并通过指标上报丢弃计数。
6. `EdgeProbe.start()` 可重复调用（幂等）。

### 进阶

- **基准测试工具** —— `harness/` 是一个独立 SwiftPM 包，以 dry-run 模式把 prompt 跑过 SDK。它既是每月基准文章的 source-of-truth，也兼作 SDK 集成烟雾测试。CLI 用法见 `harness/` 目录。
