# Final Presentation Content

## Slide 1: Title
- Streaming Procedural Terrain Generation with Wave Function Collapse
- Algorithms Design and Analysis Final Project
- Claim: a pure-backtracking streaming WFC system can deliver correct seams, deterministic revisits, and a stable live demo

## Slide 2: Initial Plan vs Final Project
- Initial plan: infinite terrain generation with WFC, persistence, and chunk streaming
- Final project: cleaned demo package, rewritten backtracking solver, reproducible experiment harness, report aligned to code
- Important correction: restart mode is retained only for controlled comparison, not for live streaming

## Slide 3: Problem Definition
- Generate terrain online as the player moves
- Every new chunk must be compatible with already committed neighbors
- Revisiting a location after eviction must reproduce the same tiles
- Target outcome: correct and presentable interactive demo

## Slide 4: Why Vanilla WFC Fails for Streaming
- Standard WFC expects a bounded offline grid
- Restart-from-scratch contradiction handling is incompatible with committed world state
- Boundary cells in new chunks inherit fixed external constraints
- Latency variance from repeated restarts is bad for real-time generation

## Slide 5: Design Evolution
- First failure: direct boundary copying produced corner contradictions
- Final fix: propagator-based domain restriction instead of forced assignment
- Deterministic recorded case:
  - left tile id `0`, top tile id `1`
  - direct assignment fails
  - propagator restriction leaves allowed set `{9}`

## Slide 6: Final System Pipeline
- Player movement updates viewport demand
- Missing visible/frontier chunks are queued
- Boundary restrictions are built from committed neighbors
- Solver runs on the seeded region
- Chunk is validated, persisted, cached, and rendered
- Figure: `fig04_pipeline.png`

## Slide 7: Solver Pseudocode
```text
solve(state):
  apply seeded restrictions
  return dfs(state)

dfs(state):
  if all cells resolved: return success
  c <- minimum entropy unresolved cell
  for tile in legal options(c):
    changes <- collapse and propagate
    if success and dfs(state): return success
    undo(changes)
  return failure
```
- Key point: final implementation uses change-record undo, not full-state cloning

## Slide 8: Streaming Scheduler Pseudocode
```text
on player move:
  update direction and viewport
  queue newly visible chunks
  queue frontier chunks near boundary
  for each queued region:
    seed from committed neighbors
    solve
    validate seams/internal adjacency
    save to memory and storage
  evict nonessential chunks
```

## Slide 9: Data Structures
- `Map<cx,cy,chunk>` for active chunk memory
- `wave[cell][tile]` boolean domain representation
- `compatible[cell][tile][dir]` support counts for fast propagation
- `counts[cell]` for entropy selection
- change-record list for undo
- `localStorage` backing for revisit consistency

## Slide 10: Complexity
- Let `n = (G + 2h)^2`, `|D| = 40`
- Cell selection: `O(n)`
- Propagation per step: `O(|Δ_k|)`
- Undo per step: `O(|Δ_k|)`
- Worst-case search: `O(|D|^n)`
- Active memory: `O(C * G^2)`
- Interpretation: propagation quality matters more than the pessimistic exponential bound in practice

## Slide 11: Controlled Experiment Design
- Sizes: `10x10`, `20x20`, `30x30`
- Runs per algorithm: `100`
- Algorithms: pure backtracking vs restart
- Restart cap: `160`
- Isolated solve cap: `5 s`
- Metrics: success rate, timeout rate, mean/median/p95 time, attempts, backtracks, contradictions

## Slide 12: Controlled Results
- Backtracking mean times:
  - `3.84 ms` at `10x10`
  - `32.28 ms` at `20x20`
  - `318.72 ms` at `30x30`
- Restart mean times:
  - `8.53 ms` at `10x10`
  - `114.29 ms` at `20x20`
  - `867.14 ms` at `30x30`
- Backtracking timeout rate: `0%`, `0%`, `3%`
- Restart mean attempts: `1.14`, `1.59`, `3.02`
- Figures: `fig_bt_vs_restart_timing.png`, `fig_attempt_count_comparison.png`, `fig_backtrack_depth.png`

## Slide 13: Streaming and Revisit Results
- Streaming mean per-generated-chunk times:
  - `8.29 ms` at `10x10`
  - `52.01 ms` at `20x20`
  - `205.95 ms` at `30x30`
- Correctness:
  - seam violations: `0` in all scenarios
  - internal violations: `0` in all scenarios
  - revisit consistency: `3/3 pass`
  - total storage reloads added by revisit tests: `68`
- Figure: `fig_streaming_timing_growth.png`

## Slide 14: Halo Ablation, Conclusion, Limitations
- Halo ablation on the final capped benchmark did not outperform `h=0`
- Example:
  - `20x20`: `h=0` success `84%`, mean `321.97 ms`
  - `h=2` success `68%`, mean `622.87 ms`
- Conclusion:
  - live streaming system is correct and presentable
  - backtracking is the better live strategy
  - halo remains implemented, but its isolated benefit needs deeper future study
- Limitation:
  - results are for one tileset and one fixed demo seed
