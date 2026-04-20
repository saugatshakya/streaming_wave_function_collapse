# Final Presentation Content

## Slide 1: Title and Claim
- Streaming Procedural Terrain Generation with Wave Function Collapse
- Algorithms Design and Analysis Final Project
- Main claim:
  - a validation-enforced streaming extension of WFC can generate, evict, and reconstruct terrain chunks via replay correctly in four directions

## Slide 2: Why This Is a Semester Project
- Standard WFC solves bounded offline grids
- My project reformulates chunk generation as an incremental CSP
- The work is not just implementation:
  - problem formulation
  - algorithm choice
  - data-structure design
  - complexity analysis
  - controlled experiments
  - long-run system validation

## Slide 3: Problem Definition
- World is divided into `G x G` chunks
- New chunks must extend an already committed world
- Required correctness properties:
  - seam correctness
  - internal correctness
  - revisit consistency after eviction and reload
- Practical performance target:
  - `16 ms` mean generation time for a smooth live demo

## Slide 4: Why Vanilla WFC Fails for Streaming
- restart-from-scratch is incompatible with committed terrain
- chunk boundaries introduce fixed external constraints
- naive boundary copying creates contradictions at corners
- online generation requires bounded latency and bounded memory

## Slide 5: Main Contribution
- Streaming terrain generation reformulated as an incremental CSP
- Boundary seeding solved by propagator-based domain restriction
- Backtracking-first live solver with strict validation before commit
- Bounded-memory cache plus storage-backed revisit recovery

## Slide 6: Design Evolution
- First failed idea:
  - direct boundary copying
- Deterministic failure case:
  - left tile `0`
  - top tile `1`
  - direct assignment fails
- Final fix:
  - intersect allowed sets from committed neighbors
  - propagator restriction leaves legal set `{9}`
- Halo was studied, but final live configuration selected `h = 0`

## Slide 7: Final System Pipeline
- player movement updates visible/frontier demand
- missing chunks are queued
- boundary restrictions are built from committed neighbors
- solver generates a candidate region
- seams and internal adjacencies are validated
- only valid chunks are committed, persisted, and rendered
- Figure: `fig04_pipeline.png`

## Slide 8: Solver Pseudocode
```text
solve(state):
  apply seeded restrictions
  propagate
  return dfs(state)

dfs(state):
  if all cells resolved: return success
  c <- minimum entropy unresolved cell
  for t in legal tiles(c):
    Δ <- collapse and propagate
    if success and dfs(state): return success
    undo(Δ)
  return failure
```
- key implementation point:
  - undo records are used instead of full-state cloning in the backtracking path

## Slide 9: Streaming Scheduler Pseudocode
```text
on player move:
  update position and direction
  queue visible missing chunks
  queue frontier chunks near boundary
  for each candidate region:
    seed from committed neighbors
    solve
    validate seams and internal adjacencies
    commit and persist
  evict distant chunks from active memory
```

## Slide 10: Data Structures Used
- `Map<cx,cy,chunk>`:
  - active chunk cache
- boolean domain arrays:
  - legal tile states per cell
- support-count arrays:
  - fast propagation
- array queue:
  - pending chunk regions
- array stack and change records:
  - DFS and undo
- `Set<int>`:
  - boundary-domain intersection
- `localStorage`:
  - persistent revisit recovery

## Slide 11: Correctness and Complexity
- Correctness idea:
  - committed chunks are never rewritten
  - only validated candidate chunks are committed
  - storage reload restores committed chunk state
- Complexity:
  - seeded initialization: `O(G^2 * |D|)`
  - validation and storage reload: `O(G^2)`
  - active memory: `O(C * G^2)`
  - persistent storage: `O(N * G^2)`
  - worst-case search: exponential
- Recurrence-tree reasoning:
  - `T(n) <= bT(n-1) + P(n)`
- Important note:
  - Master Theorem does not apply because this is not divide-and-conquer

## Slide 12: Controlled Experiment Design
- canonical bundle:
  - `streaming_wfc_experiment_bundle.json`
- compare:
  - backtracking vs restart
- sizes:
  - `10x10`, `20x20`, `30x30`
- runs per condition:
  - `100`
- metrics:
  - success rate
  - timeout rate
  - mean and p95 time
  - attempts
  - backtracks

## Slide 13: Controlled Results
- Backtracking mean times:
  - `3.84 ms` at `10x10`
  - `32.28 ms` at `20x20`
  - `318.72 ms` at `30x30`
- Restart mean times:
  - `8.53 ms` at `10x10`
  - `114.29 ms` at `20x20`
  - `867.14 ms` at `30x30`
- Backtracking remains faster at all tested sizes
- Figures:
  - `fig_bt_vs_restart_timing.png`
  - `fig_attempt_count_comparison.png`
  - `fig_backtrack_depth.png`

## Slide 14: Verified 4-Direction Endurance Result
- canonical endurance file:
  - `demo_endurance_4dir_1000_chunks.json`
- `1000` generated chunks
- `14780` tile moves
- mean generation time:
  - `1.25 ms`
- p95 generation time:
  - `1.66 ms`
- max generation time:
  - `37.72 ms`
- correctness:
  - seam violations: `0`
  - internal violations: `0`
  - sampled revisit checks: `4/4 pass`
- memory behavior:
  - peak memory: `12` chunks
  - evictions: `1980`
  - storage loads: `985`
- Figure:
  - `fig_endurance_latency_profile.png`

## Slide 15: Halo, Conclusion, and Limitations
- Halo result:
  - `h = 0` means no halo
  - halo was evaluated as a design option
  - final benchmark selected `h = 0`
- Final conclusion:
  - boundary restriction is the key fix
  - backtracking is the main algorithmic result
  - the live configuration meets the `16 ms` target on mean generation time
- Limitations:
  - strongest live evidence is for `10x10`
  - larger sizes still show a hard search regime
  - evaluation uses one tileset and one main live configuration
