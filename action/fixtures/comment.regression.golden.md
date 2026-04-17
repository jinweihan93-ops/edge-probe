### EdgeProbe · regression detected on voiceprobe-demo

**TTFT 960 ms → 1.28 s (+33%)** on `iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M`.

Baseline: `main @ abc1234` · This PR: `perf/voice-probe-slow @ def5678`

<details>
<summary>Per-turn diff (3 turns slower, 0 turns faster)</summary>

| Turn | whisper | prefill | decode | total | delta |
|------|------|------|------|------|------|
| 1 | 240 ms | 420 ms | 620 ms | 1.28 s | +33% |
| 2 | 260 ms | 480 ms | 700 ms | 1.44 s | +33% |
| 3 | 240 ms | 520 ms | 1.02 s | 1.78 s | +68% |

</details>

**View full trace →** https://edgeprobe.dev/r/A7F3

<sub>EdgeProbe 0.0.1 · threshold: 15% · [configure](https://edgeprobe.dev/app/projects/voiceprobe-demo)</sub>
