### EdgeProbe · first trace on voiceprobe-demo

**TTFT 960 ms** on `iPhone 15 Pro · iOS 18.2 · Whisper-tiny + llama-3B Q4_K_M`. No baseline to compare against yet.

This PR: `main @ 1a2b3c4`

<details>
<summary>Per-turn diff (3 turns)</summary>

| Turn | whisper | prefill | decode | total | delta |
|------|------|------|------|------|------|
| 1 | 240 ms | 320 ms | 400 ms | 960 ms | — |
| 2 | 240 ms | 360 ms | 480 ms | 1.08 s | — |
| 3 | 240 ms | 400 ms | 420 ms | 1.06 s | — |

</details>

**View full trace →** https://edgeprobe.dev/r/C9H5

<sub>EdgeProbe 0.0.1 · threshold: 15%</sub>
