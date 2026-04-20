# Streaming Procedural Terrain Generation with Wave Function Collapse

Course project repository for streaming terrain generation with Wave Function Collapse (WFC).

The project treats streaming WFC as an incremental constraint-satisfaction problem: chunks are generated next to already committed neighbors, validated before commit, evicted under a memory cap, and reconstructed on revisit from stored seed records.

## Overview

The implementation combines four core ideas:

- Boundary-seeded local solving, so new chunks are constrained by already committed neighbor tiles before search starts.
- Backtracking-first solving, so local CSP search uses depth-first search with undo logging as the primary strategy.
- Validation before commit, so candidate chunks are accepted only after seam checks and internal rule checks pass.
- Bounded-memory world state, so active chunks are capped and evicted chunks are reconstructed from stored seed metadata.

This gives a streaming pipeline that is interactive, deterministic, and auditable.

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

Report build:

```bash
pdflatex -interaction=nonstopmode main.tex
bibtex main
pdflatex -interaction=nonstopmode main.tex
pdflatex -interaction=nonstopmode main.tex
```

## Report Assets

The thesis manuscript is in `report/WFC_Masters_Thesis_Final.tex`. Figure assets used by the report live in `figures/report/`.

## Notes on Generated Files

Build artifacts such as `main.pdf`, LaTeX auxiliary files, and local virtual environments are ignored through `.gitignore` so the repository stays focused on source, figures, and experiment data.
