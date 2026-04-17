### EdgeProbe harness · regression detected on `mock-v1`

Prompt: `d5c4d7725bd06732` · 3 iterations · threshold: 15%

**Worst-case total: 1.68 s → 2.30 s (+37%)**

<details>
<summary>Per-iteration diff (3 slower)</summary>

| iter | prefill | decode | total | delta |
|------|------|------|------|------|
| 0 | 400 ms → 620 ms | 1.20 s → 1.50 s | 1.60 s → 2.12 s | +33% |
| 1 | 420 ms → 610 ms | 1.10 s → 1.44 s | 1.52 s → 2.05 s | +35% |
| 2 | 380 ms → 620 ms | 1.30 s → 1.68 s | 1.68 s → 2.30 s | +37% |

</details>

<sub>EdgeProbe harness · schema v1</sub>
