# Streaming Procedural Terrain Generation with Wave Function Collapse

Course project repository for streaming terrain generation with Wave Function Collapse (WFC).

The project treats streaming WFC as an incremental constraint-satisfaction problem: chunks are generated next to already committed neighbors, validated before commit, evicted under a memory cap, and reconstructed on revisit from stored seed records.

## Project Details

The implementation combines four core ideas:

- Boundary-seeded local solving, so new chunks are constrained by already committed neighbor tiles before search starts.
- Backtracking-first solving, so local CSP search uses depth-first search with undo logging as the primary strategy.
- Validation before commit, so candidate chunks are accepted only after seam checks and internal rule checks pass.
- Bounded-memory world state, so active chunks are capped and evicted chunks are reconstructed from stored seed metadata.

This gives a streaming pipeline that is interactive, deterministic, and auditable.

## Results

The current implementation was evaluated with three main result sets:

- Controlled benchmark comparison: backtracking is consistently faster than restart on the seeded `10x10` and `20x20` instances used in the report.
- Streaming scalability runs: `10x10` stays within the interactive range, while `20x20` exceeds the 16 ms target under load.
- Canonical 1000-chunk endurance run: the system maintained zero seam violations, zero internal violations, and consistent revisit replay under bounded memory.

Representative headline numbers from the report:

- Controlled benchmark mean solve time: `10x10` backtracking `1.45 ms`, restart `3.22 ms`.
- Controlled benchmark mean solve time: `20x20` backtracking `11.78 ms`, restart `40.37 ms`.
- Streaming mean generation time: `10x10` `3.20 ms`, `20x20` `17.46 ms`.
- Endurance run summary: mean `2.58 ms`, p95 `3.38 ms`, max `12.11 ms`.
- Endurance run integrity: seam violations `0`, internal violations `0`, sampled revisit checks `4/4` passed.
- Endurance run memory behavior: peak active memory `13` chunks with limit `12`, evictions `2056`, replay loads `1059`.

## Repository Layout

```text
streaming_wfc_v14_1_progress_ready/
├── app.js, demo.js, renderer.js, solver.js, world.js, validators.js
├── CONFIG.js, rng.js, rules.js, stats.js, utils.js, worldCommon.js
├── demo.html, index.html, demo.css
├── report/
│   ├── WFC_Masters_Thesis_Final.tex
│   ├── demo_script.md
│   └── final_presentation_content.md
├── experiments/
│   ├── run_experiments.mjs
│   ├── run_demo_endurance_4dir.mjs
│   ├── generate_result_graphs.py
│   └── result bundles and analysis data
├── figures/
│   ├── experiment graphs
│   └── report/ manuscript-specific figures
├── tiles/
├── config/
├── scripts/
└── archive/
```

## How to Run

Interactive demo:

```bash
open demo.html
```

Experiment and analysis scripts:

```bash
node experiments/run_experiments.mjs
node experiments/run_demo_endurance_4dir.mjs
python3 experiments/generate_result_graphs.py
```

