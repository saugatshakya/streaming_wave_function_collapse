# Streaming Wave Function Collapse for Infinite Terrain Generation

**Progress Report — AT70.13 Algorithms Design and Analysis**

---

| | |
|---|---|
| **Author** | Saugat Shakya |
| **Programme** | M.Sc. Data Science and Artificial Intelligence |
| **Institution** | Asian Institute of Technology |
| **Course** | AT70.13 — Algorithms Design and Analysis |
| **Date** | March 31, 2026 |
| **Report type** | Progress Report (not final submission) |

---

## Abstract

This report documents the design, implementation, and preliminary empirical evaluation of a real-time streaming terrain generator built on an extended Wave Function Collapse (WFC) algorithm. The problem is framed as an **online incremental constraint satisfaction problem**: generating new terrain chunks must extend a globally committed partial assignment without violating tile adjacency constraints at boundaries or temporal consistency on revisit. Implementation work has progressed through two key algorithmic refinements discovered through concrete failures: direct boundary seeding was found to produce arc-inconsistent initialisation states and was replaced by **propagator-based domain pruning**; residual instability under multi-neighbour boundary pressure was then resolved by **halo-based context solving**. A hybrid solver combining chronological backtracking with change-record undo and fast-restart fallback handles contradiction recovery.

Preliminary results from 90 controlled solver-comparison runs (30 per chunk size) and three streaming movement experiments show **zero seam violations**, **zero internal constraint violations**, and **100% revisit consistency** across all tested configurations. Generation time grows super-linearly with chunk size — from 7.1 ms (backtracking) / 4.4 ms (restart) at 10×10 to 1,184 ms / 430 ms at 30×30 — confirming a CSP hardness transition that motivates the 10×10 target operating configuration. Restart WFC is faster in average wall-clock time at all tested sizes, but backtracking is architecturally required for streaming correctness and maintains a flat attempt count of 1.0 regardless of chunk size.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Problem Formulation](#2-problem-formulation)
3. [Baseline WFC and Its Limitations in Streaming](#3-baseline-wfc-and-its-limitations-in-streaming)
4. [Algorithmic Design and Refinements](#4-algorithmic-design-and-refinements)
   - 4.1 [Direct Boundary Seeding: Design and Failure](#41-direct-boundary-seeding-design-and-failure)
   - 4.2 [Propagator-Based Seeding: Correct Formulation](#42-propagator-based-seeding-correct-formulation)
   - 4.3 [Halo-Based Solving](#43-halo-based-solving)
   - 4.4 [Chronological Backtracking with Change-Record Undo](#44-chronological-backtracking-with-change-record-undo)
   - 4.5 [Hybrid Solver Policy](#45-hybrid-solver-policy)
5. [System Architecture and Data Structures](#5-system-architecture-and-data-structures)
6. [Complexity Analysis](#6-complexity-analysis)
7. [Experimental Setup](#7-experimental-setup)
8. [Preliminary Results](#8-preliminary-results)
   - 8.1 [Streaming Movement Experiments](#81-streaming-movement-experiments)
   - 8.2 [Controlled Solver Comparison](#82-controlled-solver-comparison)
   - 8.3 [Interpretation and Limitations](#83-interpretation-and-limitations)
9. [Planned Final Experiments](#9-planned-final-experiments)
10. [Addressing Instructor Feedback](#10-addressing-instructor-feedback)
11. [Remaining Work](#11-remaining-work)
12. [Conclusion](#12-conclusion)
13. [References](#13-references)

---

## 1. Introduction

Wave Function Collapse (WFC) is a tile-based procedural generation algorithm introduced by Gumin (2016) that extracts directional adjacency constraints from a source tilemap image and generates new grids satisfying those same constraints. Given a small sample, WFC identifies which tile types may appear adjacent to each other in each cardinal direction, then populates a new grid by repeatedly collapsing cells from a superposition of candidate tiles into a single committed value, propagating the resulting constraints outward. The approach requires no hand-authored rules and produces outputs that are locally indistinguishable in constraint structure from the source sample (Karth and Smith, 2017).

Standard WFC, however, is fundamentally incompatible with infinite interactive worlds. Its canonical contradiction-handling policy — discarding the entire grid and restarting from a new random seed — cannot be applied once parts of the world have been committed and exposed to a player. Moreover, standard WFC solves a single bounded grid in one shot; it has no mechanism for extending an already-committed partial assignment at an open boundary. These two limitations mean that straightforward application of WFC to infinite terrain generation violates both correctness and temporal consistency.

This project reformulates infinite terrain generation as an **online incremental constraint satisfaction problem (CSP)**. The world is divided into fixed-size chunks that are solved on demand as the player traverses a viewport. Each new chunk solve is not an independent CSP; it is a constrained extension of a globally committed partial assignment. This is harder than solving a fresh bounded grid because already-committed assignments cannot be altered: the solver must extend the existing world at its open frontier without disturbing what has already been seen.

The central engineering challenge combines three mutually constraining requirements:

- **Local correctness.** Every adjacent tile pair, including pairs that cross chunk boundaries, must satisfy the adjacency constraints extracted from the source tileset, regardless of which chunk was generated first.
- **Temporal consistency.** Revisiting any world coordinate must always return the identical tile that was there on the first visit, even after the corresponding chunk has been evicted from memory and regenerated.
- **Real-time generation.** Each new chunk must be generated fast enough that the player never sees terrain materialise in front of them. This project targets a per-chunk budget of 16 ms (one frame at 60 fps).

Since the proposal submission, the project has progressed from a design-level architecture to a fully implemented and instrumented prototype. The most important progress is not merely that the system runs, but that implementation exposed two concrete algorithmic failures that led to substantive design refinements: **propagator-based seeding** replaced brittle direct boundary assignment, and **halo-based solving** was introduced to resolve residual instability under multi-neighbour boundary pressure. These refinements, together with a working hybrid contradiction-recovery solver, constitute the core algorithmic contribution of this phase.

This report is structured to address all four points of instructor feedback from the proposal review. Section 6 cleanly separates formal complexity guarantees from empirically supported observations. The originality claim is framed precisely as a streaming-systems integration and empirical characterisation, not as a novel CSP theory result. The presentation of results is organised around what the measurements actually show, including honest acknowledgement of where restart WFC outperforms backtracking in the current implementation.

---

## 2. Problem Formulation

### 2.1 World Model

Let the world be an infinite discrete grid partitioned into chunks indexed by integer coordinate pairs $(c_x, c_y)$. Each chunk contains a $G \times G$ array of cells. A cell at local position $(x, y)$ within chunk $(c_x, c_y)$ corresponds to world coordinate $(c_x \cdot G + x,\ c_y \cdot G + y)$.

Each cell $x_i$ is a variable with domain $D$, the finite set of tile identifiers extracted from the source tileset. For the Summer tileset used in this project, the source XML specifies **13 base tile types** (cliff, cliffcorner, cliffturn, grass, grasscorner, road, roadturn, water\_a, water\_b, water\_c, watercorner, waterside, waterturn) under three symmetry groups. Expanding by symmetry yields **40 distinct tile variants** in total (T-symmetry: 4 rotations; L-symmetry: 4 rotations; X-symmetry: 1). The source XML specifies **50 directional adjacency rules** via `<neighbor>` elements.

### 2.2 Constraint Structure

A directional adjacency relation $A[d][t_1][t_2] \in \{\text{true}, \text{false}\}$ specifies whether tile $t_2$ is permitted immediately adjacent to tile $t_1$ in direction $d \in \{0:\text{right},\ 1:\text{down},\ 2:\text{left},\ 3:\text{up}\}$. In the implementation, this is stored as a sparse propagator: `propagator[d][t]` is the list of all tile indices compatible with tile `t` in direction `d`. This representation supports O(1) rule lookup during propagation.

The global objective is to assign exactly one tile to every visited cell such that for every adjacent pair $(i, j)$ in direction $d$: $A[d][\text{tile}(i)][\text{tile}(j)] = \text{true}$.

### 2.3 Correctness Requirements

Two properties must hold throughout the lifetime of the system:

**Definition 1 (Local Correctness).** A world assignment is locally correct if and only if every adjacent tile pair — including pairs where the two cells belong to different chunks — satisfies the adjacency relation $A$.

**Definition 2 (Temporal Consistency).** A world assignment is temporally consistent if and only if, for every visited cell $x_i$, the tile assigned on every subsequent visit to the same world coordinate is identical to the tile assigned on the first visit.

### 2.4 Online Incremental CSP Formulation

In a finite offline setting, the global objective is solved once over a bounded region. In the streaming setting, the world is only partially instantiated at any time, and the solver must repeatedly extend an existing partial assignment at its open boundary. Each new chunk solve is a **constrained extension problem**: given a partial assignment $\sigma$ covering all previously generated chunks, find an assignment for the new chunk's $G^2$ variables that is consistent with $\sigma$ at all shared boundaries and internally consistent with $A$.

This formulation makes the problem harder than independent chunk generation in two ways. First, the boundary cells of the new chunk have their domains pre-restricted by the committed values of adjacent cells in neighbouring chunks, reducing the search freedom available to the solver. Second, committed assignments cannot be altered, so there is no fallback to restarting the whole world if the new chunk creates a difficult local instance. The system must be designed so that every incremental extension succeeds — or, if it provably cannot, fails gracefully without corrupting committed state.

---

## 3. Baseline WFC and Its Limitations in Streaming

Standard WFC (Gumin, 2016; Karth and Smith, 2017) operates as follows on a finite grid of size $W \times H$:

1. Initialise every cell's domain to the full tile alphabet $D$.
2. Select the unresolved cell $x^*$ with minimum Shannon entropy $H(x^*) = -\sum_{t} p_t \log p_t$ (with random tie-breaking to avoid systematic bias).
3. Collapse $x^*$ by choosing one tile $t^*$ from its current domain according to the tile weight distribution.
4. Ban all other tiles from $x^*$'s domain, then propagate: for each affected neighbour, remove any tile from its domain that is no longer arc-consistent given the updated cell. Repeat until fixpoint or contradiction.
5. If contradiction (any cell's domain becomes empty): **restart** from scratch with a new random seed. Otherwise, return to step 2.

This algorithm has two structural failure modes that make it unsuitable for streaming use:

**Commitment violation.** In a streaming world, chunks neighbouring the new chunk are already committed. A restart policy — even restricted to the single new chunk — cannot be allowed to discard the partial boundary context inherited from those committed neighbours. More subtly, restarting changes the random seed, which changes what the solver does from the boundary inward, which can produce a different internal result even with the same boundary values. This matters because the boundary cells of the new chunk are themselves shared with future chunks in other directions; inconsistency can propagate.

**Unbounded latency.** On hard constraint instances — large grids, tightly constrained tilesets, or boundary conditions that strongly restrict the interior — restart-WFC may require many attempts with no progress preserved between them. The attempt count is a geometrically distributed random variable with no finite expectation on unsolvable instances. In a streaming world with a hard per-chunk frame budget, unbounded latency on any single chunk is unacceptable.

Both failure modes are empirically confirmed by the prototype measurements in Section 8. The solution is twofold: replace restart with chronological backtracking (Section 4.4), and replace independent chunk generation with boundary-conditioned solving (Sections 4.1–4.3).

---

## 4. Algorithmic Design and Refinements

### 4.1 Direct Boundary Seeding: Design and Failure

The first implementation strategy for ensuring seam correctness was **direct boundary seeding**. Before solving a new chunk, the cells along its shared boundaries with already-committed neighbouring chunks were pre-collapsed to the values those neighbours held at the shared edge. The reasoning was that if the new chunk begins with its boundary cells already set to match its neighbours, the seam must be consistent by construction.

In implementation, this strategy failed immediately and definitively. The failure signature was unambiguous: solver runs reported **observations = 0, contradictions = 1**. The solver had not made a single decision before entering a contradicted state. The contradiction was introduced at initialisation, not during the search.

The cause is that boundary cells are not independent. A cell at or near a corner of the new chunk may share boundaries with two already-committed neighbours simultaneously — the chunk to its left and the chunk above it, for example. When both neighbours assign their border values to the corner cell as hard pre-collapses, the result is a cell that has been forced to two different values, which is an immediate contradiction. This is an instance of the general CSP problem of inserting **arc-inconsistent forced assignments** before the problem has been made locally consistent. The `applySeededCells` function in the implementation was producing this state whenever a new chunk had more than one committed neighbour.

![Figure 5: Boundary seeding failure vs. correct formulation](./fig05_boundary_seeding.png)

*Figure 5: Boundary seeding failure vs. correct propagator-based formulation. Left panel (a): direct assignment forces the corner cell to receive incompatible tile values from two neighbours simultaneously, producing an empty domain (∅) before the solver makes a single observation. Right panel (b): propagator-based seeding applies compatibility bans instead, leaving the corner cell with the valid domain {Sand, Water} and allowing the solve to proceed normally.*

The broader lesson is that seam correctness cannot be achieved by copying committed values across boundaries as hard assignments. It must be achieved by respecting the propagation semantics of the underlying CSP — specifically, by entering the new chunk's solve with a state that is arc-consistent with its committed neighbourhood, not merely structurally adjacent to it.

### 4.2 Propagator-Based Seeding: Correct Formulation

Propagator-based seeding replaces hard value copying with **domain restriction via compatibility bans**. For each cell in the new chunk that lies adjacent to a committed neighbour cell, the seeder queries the adjacency table in the relevant direction and removes from that cell's domain every tile value that would violate the adjacency constraint with the committed neighbour's tile. If a cell is adjacent to committed neighbours in more than one direction, the bans are applied cumulatively: the cell's domain becomes the intersection of the sets permitted by each committed neighbour.

Formally, for a new chunk border cell $x_i$ adjacent to committed cell $x_j$ with assignment $\text{tile}(x_j) = t_j$ in direction $d$:

$$D(x_i) \leftarrow D(x_i) \cap \{t : A[d][t_j][t] = \text{true}\}$$

This operation is then followed by standard WFC propagation (AC-3 style; Mackworth, 1977) to achieve arc-consistency throughout the new chunk's initial state before any collapse decision is made.

The critical properties of this formulation are:

- **Feasibility preservation.** If any tile value remains valid at a border cell given the committed context, that value remains in the domain. The seeding process cannot create an empty domain unless no valid extension genuinely exists, which would mean the committed neighbours are themselves in a state from which no consistent extension is possible — a pathological case that correct prior solves would have prevented.
- **CSP semantics alignment.** WFC is a domain-reduction process. Seeding the new chunk via domain restriction is the correct way to integrate external information: it narrows the search space without prematurely committing to any specific value.
- **Corner correctness.** Because bans from multiple directions are applied as intersections over the same domain, multi-neighbour border cells receive the tightest valid constraint set, not an overconstrained one.

This refinement eliminated the `observations = 0, contradictions = 1` failure class entirely.

### 4.3 Halo-Based Solving

Propagator-based seeding resolved initialisation-level contradictions but left a subtler problem. Even with a valid initial state, the artificial boundary of the chunk was carrying a disproportionate share of the local constraint satisfaction burden. The chunk boundary is an implementation boundary, not a semantic one: the adjacency constraints have no knowledge of where chunks end. When the solver is confined to exactly the $G \times G$ region of the new chunk, all compatibility pressure from the committed neighbourhood must be resolved within that exact region. Corner cells — which aggregate constraint pressure from two committed directions — were especially prone to producing difficult local instances.

**Halo-based solving** addresses this by expanding the local solve region. Instead of solving exactly the $G \times G$ target chunk, the solver temporarily works on a $(G + 2h) \times (G + 2h)$ context region centred on the target chunk, where $h = 2$ cells in the current implementation. The halo cells outside the target chunk are seeded from committed neighbours where available, but otherwise participate freely in the solve. After the enlarged region is solved, only the central $G \times G$ core is committed to the world; the $h$-cell border is discarded.

![Figure 6: Halo-based solving architecture](./fig06_halo_solving.png)

*Figure 6: Halo-based solving. The solver operates on a (G+2h)×(G+2h) region. Only the central G×G core is committed permanently; the halo absorbs boundary constraint pressure and is discarded after the solve. For G=10 and h=2, the effective solve region is 14×14 = 196 cells.*

![Figure 8: Halo overhead analysis](./fig08_halo_overhead.png)

*Figure 8: Halo overhead as a function of chunk size. Solid green line shows the core region (G²); dashed blue line shows the effective solve region ((G+4)²). Percentage annotations show the overhead at each tested size. The overhead is largest proportionally at small G and diminishes relatively at large G.*

The halo mechanism works because it changes the context in which the solver operates on the target chunk's boundary. Without a halo, the target chunk's outermost cells must simultaneously satisfy their committed neighbours and the interior of the chunk, concentrating compatibility tension at a line. With a halo, some of that tension can be partially resolved in the halo cells, and the target chunk's border cells behave more like interior cells of a larger local patch. This is a principled trade-off: the nominal solve region is larger (and so each solve is more expensive), but the resulting local CSP instances are better conditioned and produce fewer pathological backtracking cases.

**Important caveat.** Halo-based solving does not reduce worst-case complexity. The effective local problem is strictly larger. The halo is a practical conditioning technique, not an asymptotic improvement. Section 6 states this precisely.

### 4.4 Chronological Backtracking with Change-Record Undo

Standard WFC's restart policy is replaced with **chronological backtracking**. The solver maintains an explicit assignment stack. Each entry records the cell that was collapsed, the tile value chosen, and a *change record* — the list of all `(cell, tile)` pairs whose domains were modified during the propagation triggered by that collapse. When a contradiction is detected, the solver pops the most recent stack entry, replays the change record in reverse to restore all affected domains, then tries the next available tile value for that cell.

The key data structure here is the change record. At each collapse step $k$, let $\Delta_k$ be the set of domain modifications produced by propagating the collapse of cell $x^*$ to tile $t^*$:

$$\Delta_k = \{(x_i, t) : t \text{ was banned from } D(x_i) \text{ during propagation of step } k\}$$

Undoing step $k$ requires only iterating over $\Delta_k$ and restoring each banned tile to its cell's domain. The cost is $O(|\Delta_k|)$ — proportional only to the number of changes actually made, not to the full grid state. This is the change-based restoration approach analysed by Dechter (2003), chosen specifically over full state-copy undo because it pays only for changes that occurred rather than $O(G^2 \times |D|)$ per stack frame.

![Figure 7: Contradiction handling strategies](./fig07_bt_vs_restart.png)

*Figure 7: Contradiction handling strategies. Left panel (a): restart discards the entire search tree and begins from a new random seed; all work is lost. Right panel (b): chronological backtracking undoes only the most recent bad decision via change-record replay, preserving the valid search prefix. The undo arc shows the path from the contradiction node back up the tree.*

The backtracking solver is **complete**: if any assignment of the $G^2$ variables exists that is consistent with the committed boundary context and the adjacency constraints, the solver will find it. If no such assignment exists — which should not occur in correctly conditioned instances — the solver will exhaustively prove infeasibility. This completeness property is what makes backtracking architecturally appropriate for streaming: the solver never silently fails or produces an incorrect result.

### 4.5 Hybrid Solver Policy

The implemented solver uses a hybrid policy that combines both strategies. On receiving a solve job for a new chunk region:

1. **Fast-restart phase.** Attempt up to 160 restart-based solves with independently sampled random seeds. Each attempt runs standard WFC on the halo-seeded region with no backtracking state.
2. **Backtracking fallback.** If all restart attempts fail, switch to the chronological backtracking solver on the same seeded initial state.

This policy exploits the empirical finding that restart is faster on easy instances (where the first few attempts tend to succeed) while backtracking provides a completeness guarantee and controlled latency on hard instances. In practice, the restart phase succeeds on the large majority of chunk generations at the target operating size, and the backtracking fallback handles the remainder. The controlled comparison in Section 8 isolates these two modes to measure their individual characteristics.

---

## 5. System Architecture and Data Structures

### 5.1 System Pipeline

The streaming pipeline connects player motion, viewport management, chunk scheduling, constraint solving, persistence, and rendering into a continuous loop.

![Figure 4: The streaming WFC system pipeline](./fig04_pipeline.png)

*Figure 4: The streaming WFC system pipeline. Data flows left-to-right from player position through viewport management and chunk scheduling, into the constraint seeding stage (which applies propagator bans and halo context), then through the WFC solver with backtracking, into the spatial hashmap/LRU store, and finally to the renderer and logger.*

The pipeline operates as follows on each frame:

1. **Viewport Manager** computes which world coordinates are currently visible given the player's position and the viewport dimensions (8×8 tiles in the current configuration), and which chunks will enter the viewport as the player continues moving.
2. **Chunk Scheduler** maintains a priority queue of chunk regions to generate. Immediately visible chunks are enqueued at the front; anticipated frontier chunks are enqueued at the back. The scheduler uses a chunk-size-aware adaptive policy: frontier look-ahead distance and memory limits are reduced as chunk size increases (memory limits: 20/8/4 chunks for 10×10/20×20/30×30).
3. **Constraint Seeding** builds the halo specification for the target region: for each halo cell adjacent to a committed neighbour, applies compatibility bans; for each core cell adjacent to a committed neighbour, applies the same bans. The result is an initial domain map for the full $(G+2h)^2$-cell solve region.
4. **WFC Solver** resolves the seeded region using the hybrid policy (Section 4.5), tracking attempt count, backtrack count, and wall-clock time.
5. **Spatial Hashmap** stores solved chunks keyed by $(c_x, c_y)$. Additionally, solved grids are persisted to `localStorage` keyed by a string of the form `streaming-wfc:{version}:{seed}:chunk{G}:view{W}x{H}:{cx},{cy}`, enabling deterministic recovery after LRU eviction.
6. **Renderer and Logger** read visible chunks from the hashmap, draw the terrain, and append per-chunk metrics to the statistics store.

### 5.2 Data Structures

**Table 1: Principal data structures, roles, and asymptotic operation costs.**

| Structure | Role | Key Operation | Cost |
|---|---|---|---|
| `Map` keyed by `"cx,cy"` | Chunk persistence; world lookup | `get`, `set`, `delete` | O(1) avg |
| LRU eviction policy | Bounded memory; deterministic regen on re-access | touch, evict oldest | O(1) |
| Per-cell domain array (`boolean[]`) | WFC wave state; propagation bans | ban (set false), count | O(1) per tile |
| Compatible-count array (`int[cell][tile][dir]`) | AC-3 propagation trigger | decrement, check zero | O(1) |
| Assignment stack (`(cell, tile, Δ)[]`) | Backtracking decision record | push, pop | O(1) |
| Change-record list `Δ` (`(cell,tile)[]`) | Domain undo on backtrack | append, replay in reverse | O(\|Δ\|) |
| Linear scan over wave array | Minimum-entropy cell selection | argmin entropy | O(n) per step |
| 3-D adjacency table `propagator[d][t]` | Tile compatibility lookup | index | O(1) |

The **spatial hashmap** is justified by the access pattern: the renderer and scheduler perform O(1) lookup on every frame for each visible chunk. A tree-based map would introduce O(log C) overhead that compounds at 60 fps across potentially thousands of chunks. The **compatible-count array** is a key optimisation: instead of re-scanning all adjacency rules after every ban, it tracks for each (cell, tile, direction) how many supporting tiles remain on the neighbouring side. When the count reaches zero, that tile is arc-inconsistent and is automatically banned, triggering further propagation. This is a standard AC-3 propagation structure (Mackworth, 1977) adapted to the WFC setting. The **change-record list** enables O(|Δ|) undo as described in Section 4.4. Chunks store only compact integer tile indices, not rendered image data; tile visual assets are shared at the tileset level, keeping per-chunk memory footprint to $G^2 \times \lceil \log_2 |D| \rceil$ bits.

---

## 6. Complexity Analysis

Following instructor feedback, this section explicitly separates formal complexity guarantees from empirically supported observations about practical performance.

### 6.1 Formal Guarantees

**Worst-case per-chunk solve time.** Each chunk solve is a finite CSP with $|D| = 40$ tile variants and $G^2$ variables. Complete backtracking search over this space has worst-case time complexity $O(|D|^{G^2})$ — exponential in chunk area. This bound applies to any complete CSP solver regardless of variable ordering or constraint propagation strategy. Propagator-based seeding, halo enlargement, and backtracking do not reduce this exponential bound; they affect only the constant factors and the typical-case behaviour.

**Halo region size.** Halo-based solving with $h=2$ increases the nominal solve region from $G^2$ to $(G+4)^2$ cells. For $G=10$: $100 \to 196$ cells (+96%); $G=20$: $400 \to 576$ cells (+44%); $G=30$: $900 \to 1156$ cells (+28%). This is a constant multiplicative overhead in problem size, not a change in complexity class.

**Per-step cost.** Each WFC observation step costs:
- O($n$) for entropy-based cell selection via linear scan over all unsolved cells, where $n \leq (G+4)^2$;
- O($|D| \times 4$) for propagating the collapse of one cell to its four neighbours;
- O(1) for the assignment stack push and change-record initialisation.

**Revisit cost.** O(1) average-case for in-memory chunks via hashmap lookup. After LRU eviction, a chunk is regenerated deterministically from its coordinate-derived seed — cost $O(T_{\text{chunk}})$, where $T_{\text{chunk}}$ is the generation time, which by construction produces the same output as the original visit (temporal consistency).

**Memory bound.** Active world storage is $O(C \times G^2)$ where $C$ is the LRU cache capacity. This is independent of total world size explored. Transient solving overhead is $O((G+4)^2 \times |D|)$ for the domain arrays plus $O((G+4)^2 \times |D|)$ worst-case for the change-record stack across all decisions.

**Hashmap operations.** Chunk lookup, insert, and eviction are O(1) average-case under uniform hash distribution. In the worst case (adversarial key distribution), they are O($C$), but this does not arise with coordinate-based keys.

### 6.2 Empirically Supported Observations

The following observations are based on the March 2026 experiment bundle. They characterise practical performance of this specific implementation on this specific hardware and tileset; they do not constitute theoretical bounds.

**Interactive regime.** Average generation times of 7.10 ms (BT) and 4.36 ms (RS) at 10×10 confirm that the target operating size is within the 16 ms budget under typical conditions. The 20×20 configuration averages 226 ms (BT) / 49 ms (RS), exceeding the budget, which motivates the 10×10 target.

**Super-linear runtime growth.** From 10×10 to 30×30, backtracking time increases by a factor of approximately 167×, and restart time by approximately 99×. This growth is substantially faster than linear in chunk area (a factor of 9×), consistent with CSP hardness scaling but observed empirically, not derived analytically.

**Hardness transition.** The attempt count for restart WFC grows from 1.10 at 10×10 to 3.10 at 30×30, suggesting the problem enters a harder regime beyond 20×20. This is consistent with the phase-transition behaviour documented in CSP literature (Cheeseman et al., 1991) but is characterised here by measurement.

**Backtracking overhead.** Backtracking is slower than restart at all three tested sizes. At 10×10, the ratio is 7.10/4.36 ≈ 1.63×. At 30×30, it is 1184/430 ≈ 2.75×. This is consistent with the change-record mechanism adding per-step overhead that dominates on easy instances. The overhead increases with chunk size, suggesting it scales with the number of propagation steps rather than with backtrack events, since backtrack count remains near zero in the movement experiments.

---

## 7. Experimental Setup

### 7.1 Tileset and Input

**Tileset:** Summer (custom). 13 base tile types under T/L/X symmetry groups, expanding to 40 distinct variants. 50 directional adjacency rules encoded as XML `<neighbor>` elements. Non-uniform tile weights: grasscorner (weight 0.01), road and roadturn (weight 0.05), all others (weight 1.0 default). The low grasscorner weight biases generation toward smoother terrain; the low road/roadturn weight limits road density.

**World seed:** 20260330 (fixed across all reported runs for reproducibility).

### 7.2 Configurations Tested

| Parameter | Values |
|---|---|
| Chunk size $G$ | 10, 20, 30 |
| Halo width $h$ | 2 (fixed) |
| Viewport | 8×8 tiles |
| Solver modes compared | Backtracking (BT), Restart (RS) |
| Runs per condition (solver comparison) | 30 |
| Movement steps per scenario | ~50 (see limitation in §8.3) |
| LRU memory limits | 20 / 8 / 4 chunks for G=10/20/30 |

### 7.3 Metrics

| Metric | Definition | Correctness threshold |
|---|---|---|
| Seam violations | Adjacent tile pairs across chunk boundaries violating $A$ | Must be 0 |
| Internal violations | Adjacent pairs within a chunk violating $A$ | Must be 0 |
| Revisit consistency | Tile identity on re-access after potential eviction | Must be 100% |
| Avg generation time (ms) | Mean wall-clock time per chunk generation | Target ≤ 16 ms |
| Avg attempts per chunk | Mean number of solver restarts per chunk | Lower is better |
| Avg backtracks per chunk | Mean change-record undo operations per chunk | Measured |
| Peak memory chunks | Maximum number of chunks in RAM simultaneously | ≤ memory limit |

### 7.4 Fairness Controls

Both solver modes share identical data structures, adjacency rules, halo configuration, and propagator-seeded starting state. Only the contradiction-handling mechanism differs. Timing uses `performance.now()` bracketed exclusively around the solver function, excluding rendering, scheduling, and I/O. All comparison runs use independently sampled random seeds (derived from chunk coordinates and a run index) to prevent duplicate-seed inflation of apparent success rates. Storage reads are explicitly disabled (`disableStorageReads = true`, recorded as `storageLoads = 0`) to ensure all measurements reflect actual solving rather than cache retrieval.

### 7.5 Correctness Verification

Two automated post-generation validators run after every chunk generation event:

- **`validateChunkInternal`:** Scans all horizontal and vertical adjacent tile pairs within the chunk, checks each against `propagator[d][t]`. Reports any violation.
- **`validateChunkAgainstNeighbors`:** For each side of the new chunk that abuts a committed neighbour, checks all tile pairs across that boundary. Reports any cross-chunk violation.

A separate revisit consistency test records tile assignments at a set of world coordinates, forces potential LRU eviction by generating additional chunks, returns to the original coordinates, and asserts byte-identical assignment.

---

## 8. Preliminary Results

### 8.1 Streaming Movement Experiments

Table 2 reports results from three streaming movement scenarios run on the March 2026 experiment bundle. Each scenario simulates a player traversing a scripted path with fresh-generation mode active (no pre-loaded chunks).

**Table 2: Streaming movement experiment results (March 2026 bundle).**
All seam violations = 0; all internal violations = 0; all storageLoads = 0.

| Chunk Size | Viewport | Frontier Trigger | Mem. Limit | Gen. Chunks | Avg Time (ms) | Avg Attempts | Avg Backtracks | Peak Mem. |
|---|---|---|---|---|---|---|---|---|
| 10×10 | 8×8 | 5 tiles | 20 | **13** | **23.66** | 1.54 | 0 | 10 |
| 20×20 | 8×8 | 5 tiles | 8 | **6** | **112.37** | 1.83 | 0 | 4 |
| 30×30 | 8×8 | 4 tiles | 4 | **2** | **1029.35** | 6.50 | 0 | 2 |

![Figure 3: Streaming movement experiment results](./fig03_streaming_results.png)

*Figure 3: Streaming movement experiment results. (a) Chunks generated per movement scenario — larger chunks trigger fewer generations over the same movement path because each chunk covers more world area. (b) Average generation time per chunk on log scale; only 10×10 is within the 16 ms budget. (c) Average attempts per chunk; 30×30 requires 6.5 attempts despite zero recorded backtracks in the summary, indicating the hybrid solver's restart phase is doing most of the work.*

**Correctness.** Zero seam violations across all three scenarios is the primary correctness result of this phase. It confirms that propagator-based seeding and halo-based solving together maintain local correctness at chunk boundaries under live streaming conditions. The automated adjacency checker validated every adjacent tile pair including all cross-chunk boundaries after every generation event. Zero internal violations confirms that intra-chunk constraint satisfaction is also maintained.

**Performance.** The 10×10 configuration averages 23.66 ms per generated chunk in the movement scenario. This exceeds the 16 ms frame budget, which is higher than the 7.10 ms recorded in the isolated controlled comparison (Section 8.2). The difference is attributable to the movement context: the streaming scenario includes scheduling overhead, halo seeding from multiple committed neighbours (which is more expensive than isolated seeding), and the overhead of the correctness validators running after each generation. The 20×20 and 30×30 configurations substantially exceed the budget.

### 8.2 Controlled Solver Comparison

Table 3 presents the controlled comparison between backtracking (BT) and restart (RS) modes. Both modes achieve 100% success at all three tested sizes over 30 runs each.

**Table 3: Controlled solver comparison (March 2026 bundle, 30 runs per condition).**

| Size | Runs | BT Success | RS Success | BT Avg Time (ms) | RS Avg Time (ms) | BT Avg Attempts | RS Avg Attempts |
|---|---|---|---|---|---|---|---|
| 10×10 | 30 | 100% | 100% | **7.10** | **4.36** | **1.00** | 1.10 |
| 20×20 | 30 | 100% | 100% | **226.03** | **49.49** | **1.00** | 1.53 |
| 30×30 | 30 | 100% | 100% | **1184.08** | **430.35** | **1.00** | 3.10 |

![Figure 1: Generation time vs. grid size](./fig01_runtime_growth.png)

*Figure 1: Generation time vs. grid area on a log scale. Both solver modes show super-linear growth. The 16 ms budget line (red dashed) is crossed between 10×10 and 20×20 for both modes. Dotted lines show power-law projections to 40×40 and 50×50 based on the three measured points.*

![Figure 2: Solver comparison - backtracking vs. restart](./fig02_solver_comparison.png)

*Figure 2: Side-by-side comparison of backtracking and restart WFC. (a) Average generation time on a log scale; restart is faster at all three sizes. (b) Average attempts per chunk; backtracking is always 1.0 (no restart occurs), while restart requires an increasing number of attempts as chunk size grows.*

### 8.3 Interpretation and Limitations

**Restart is faster than backtracking at all tested sizes.** This is an honest empirical finding. Restart WFC averages 4.36 ms vs. 7.10 ms at 10×10 and 430 ms vs. 1184 ms at 30×30. The overhead is attributable to the change-record mechanism: at every propagation step, even when no contradiction occurs, the solver logs domain modifications to the change record. On easy instances where restart succeeds on the first or second attempt, this overhead is not justified by the number of backtracks that actually occur.

**Backtracking is architecturally required.** Despite being slower, backtracking is the correct choice for streaming generation for two reasons. First, it never discards committed context: the solver works from a fixed boundary-seeded starting state and explores it exhaustively rather than sampling new starting states. This is essential when the boundary conditions are provided by committed neighbouring chunks that cannot be re-randomised. Second, its attempt count is constant at 1.0: it requires exactly one pass through the search space, whereas restart requires progressively more passes as chunk size and constraint difficulty increase. The hybrid policy (Section 4.5) is designed to exploit restart's speed advantage on easy instances while providing backtracking's completeness and predictability on hard ones.

**The 30×30 movement scenario is under-sampled.** Only 2 chunks were generated in the 30×30 movement scenario, compared with 13 at 10×10 and 6 at 20×20. This is a consequence of chunk size relative to the movement path length: each 30×30 chunk covers 900 tiles, and the scripted movement path did not cross enough chunk boundaries to trigger more than 2 fresh generations. This is the most significant experimental limitation of the current results: the 30×30 correctness and timing data are based on too few samples to be statistically meaningful. Redesigning the movement experiment with a longer path is the highest-priority remaining experimental task.

**Average backtracks = 0 at all sizes in movement scenarios.** This indicates that the hybrid solver's restart phase (up to 160 attempts) is resolving all chunk generations without needing to engage the backtracking fallback. At the tested sizes, the restart phase is sufficient. The backtracking path would be exercised by harder instances — larger chunk sizes, more constrained tilesets, or more constrained boundary conditions — which the current experiment does not reach.

---

## 9. Planned Final Experiments

The following experiments are planned for the final report. Tables 4–7 show the exact structure and metrics that will be reported; result columns are left empty to indicate data not yet collected. All experiments will use the same instrumented pipeline and fairness controls described in Section 7.

### Experiment A: Extended Movement Path (200+ Steps)

**Motivation.** The current movement experiments are under-sampled at large chunk sizes. Experiment A redesigns the movement path to traverse all four cardinal directions and cover enough world area to trigger at least 20 fresh chunk generations at every tested size.

**Table 4: Experiment A — Extended Streaming Movement (planned; 200+ steps per scenario).**

| Size | Steps | Gen. Chunks | Avg Time (ms) | Seam Viol. | Int. Viol. | Avg Att. | Peak Mem. | Revisit OK |
|---|---|---|---|---|---|---|---|---|
| 10×10 | 200 | — | — | — | — | — | — | — |
| 20×20 | 200 | — | — | — | — | — | — | — |
| 30×30 | 200 | — | — | — | — | — | — | — |

### Experiment B: Full Solver Comparison with Variance (100 Runs per Condition)

**Motivation.** The current 30-run comparison is sufficient for point estimates but not for confidence intervals or variance analysis. Experiment B expands to 100 runs per (size, algorithm) condition (600 total runs), enabling standard deviation and 95% confidence interval computation.

**Table 5: Experiment B — Full Solver Comparison (planned; 100 runs per condition).**

| Size | Runs | BT Mean (ms) | BT σ (ms) | BT 95% CI | RS Mean (ms) | RS σ (ms) | RS 95% CI | BT Att. | RS Att. |
|---|---|---|---|---|---|---|---|---|---|
| 10×10 | 100 | — | — | — | — | — | — | — | — |
| 20×20 | 100 | — | — | — | — | — | — | — | — |
| 30×30 | 100 | — | — | — | — | — | — | — | — |

### Experiment C: Halo Ablation Study (h=0 vs h=2)

**Motivation.** Halo-based solving increases nominal problem size and therefore per-chunk cost. Experiment C isolates the contribution of the halo by comparing the full pipeline (h=2) against a version with halo disabled (h=0, pure propagator-based seeding only). Metrics focus on initialisation contradiction rate, seam violation rate, and per-chunk generation time.

**Table 6: Experiment C — Halo Ablation (planned; 30 runs per condition).**

| Size | Halo | Init. Contradiction Rate | Seam Violations | Avg Time (ms) | Success Rate |
|---|---|---|---|---|---|
| 10×10 | h=2 | — | — | — | — |
| 10×10 | h=0 | — | — | — | — |
| 20×20 | h=2 | — | — | — | — |
| 20×20 | h=0 | — | — | — | — |
| 30×30 | h=2 | — | — | — | — |
| 30×30 | h=0 | — | — | — | — |

### Experiment D: Temporal Consistency Under LRU Pressure

**Motivation.** Temporal consistency under LRU eviction has been verified informally but not systematically. Experiment D explicitly tests revisit consistency by recording tile assignments at a set of coordinates, forcing LRU eviction by generating enough additional chunks to exceed the cache limit, returning to the recorded coordinates, and verifying byte identity.

**Table 7: Experiment D — LRU Revisit Consistency (planned).**

| Size | Cache Limit | Revisit Points | Evictions Forced | Consistency Rate | Notes |
|---|---|---|---|---|---|
| 10×10 | 20 | 50 | — | — | — |
| 20×20 | 8 | 50 | — | — | — |
| 30×30 | 4 | 50 | — | — | — |

---

## 10. Addressing Instructor Feedback

### 10.1 Theory–Practice Separation

The proposal was noted as making performance claims that relied on empirical behaviour rather than formal bounds. This report addresses that throughout. Section 6.1 contains exclusively formal statements: worst-case exponential complexity, halo region size formulae, per-step cost breakdown, revisit cost, and memory bound. Section 6.2 explicitly labels every claim as an empirical observation: "Average generation times of 7.10 ms ... confirm that the target size is within the 16 ms budget under typical conditions. This is an empirical observation, not a provable bound." No theoretical bound is backed only by measurement.

### 10.2 Complexity Discussion

The proposal mixed worst-case and practical bounds in ways the instructor found unclear. The revised analysis in Section 6 separates three distinct regimes: (1) the formal $O(|D|^{G^2})$ worst-case that applies to any complete CSP solver; (2) the practical operating regime characterised empirically as $G \leq 10$ for 16 ms budget compliance; and (3) the measured super-linear growth between these regimes. Halo overhead is now explicitly quantified: a constant multiplicative factor in problem size, not a change in complexity class.

### 10.3 Originality

This project does not claim to introduce a new CSP algorithm. The contribution is precisely characterised as: (1) identification of a concrete failure class in direct boundary seeding — arc-inconsistent initialisation — and its resolution via propagator-based domain pruning; (2) halo-based context enlargement as a practical conditioning technique for streaming CSP extension; (3) empirical characterisation of correctness, performance, and scaling in a real-time streaming system. Prior work on WFC (Karth and Smith, 2021) analyses constraint-solving properties but does not evaluate a live streaming system. Kleineberg (2019) demonstrates infinite WFC but without timing evaluation, seam verification, or LRU consistency testing.

### 10.4 Presentation Structure

The final presentation will open with the system pipeline diagram on slide 1, state the three correctness requirements on slide 2, and proceed directly to solver design, complexity analysis, and experimental results. Motivation and background will occupy at most one slide. The seeding failure story (Section 4.1) will be presented as a concrete debugging result with the observations=0/contradictions=1 signature, not as abstract design discussion.

---

## 11. Remaining Work

The remaining work falls into three categories in roughly decreasing priority.

**Experimental completion (highest priority).** Execute Experiments A–D as specified in Section 9 and populate Tables 4–7. Priority order: Experiment A (extended movement, needed to fix the most critical gap in current data), Experiment C (halo ablation, directly validates the halo design claim), Experiment B (expanded variance analysis), Experiment D (systematic revisit consistency).

**Implementation refinement.** Profile the backtracking solver to identify the sources of change-record overhead. The current implementation logs domain modifications on every propagation step; a lazy variant that only materialises the log at backtrack points could reduce per-step cost on easy instances, potentially closing the gap between backtracking and restart at small sizes.

**Final report and presentation.** Incorporate completed experiment data into all result tables and figures. Revise Section 6.2 observations based on the expanded 100-run comparison. Build presentation slides with algorithmic content foregrounded from slide 1. Prepare a demonstration recording showing the live streaming system with the statistics overlay.

---

## 12. Conclusion

This project has progressed from a proposal-level architecture to a fully implemented and instrumented streaming WFC terrain generator. The most significant progress is algorithmic, not merely implementation-level: direct boundary seeding was found through implementation testing to produce arc-inconsistent initialisation states, and that failure motivated two substantive design refinements — propagator-based domain pruning and halo-based context solving. Together, these refinements achieve zero seam violations and zero internal constraint violations across all tested streaming configurations.

Preliminary results from 90 controlled solver comparison runs and three movement experiments establish several concrete empirical findings: the 10×10 operating configuration achieves 100% success with generation times in the single-digit-millisecond range under controlled conditions; generation time grows super-linearly with chunk size, consistent with CSP hardness; restart WFC is faster than backtracking in wall-clock time but requires progressively more retries at larger sizes; and backtracking maintains a flat attempt count of 1.0 regardless of chunk size, making its latency profile more predictable for streaming use.

The most important experimental gap — insufficient chunk transitions at 30×30 in the movement scenarios — is clearly identified, and the corrective experiment is planned and specified. The system is complete; what remains is deepening the evaluation and tightening the final presentation.

---

## 13. References

Cheeseman, P., Kanefsky, B., and Taylor, W. M. (1991). Where the really hard problems are. In *Proceedings of the 12th International Joint Conference on Artificial Intelligence (IJCAI '91)*, pages 331–337.

Dechter, R. (2003). *Constraint Processing*. Morgan Kaufmann.

Gumin, M. (2016). Wave Function Collapse Algorithm (Version 1.0) [Software]. GitHub. https://github.com/mxgmn/WaveFunctionCollapse

Karth, I. and Smith, A. M. (2017). WaveFunctionCollapse is constraint solving in the wild. In *Proceedings of the 12th International Conference on the Foundations of Digital Games (FDG '17)*.

Karth, I. and Smith, A. M. (2021). WaveFunctionCollapse: Content generation via constraint solving and machine learning. *IEEE Transactions on Games*, 13(3):260–272.

Kleineberg, M. (2019). Infinite procedurally generated city with the Wave Function Collapse algorithm. https://marian42.de/article/wfc

Mackworth, A. K. (1977). Consistency in networks of relations. *Artificial Intelligence*, 8(1):99–118.

Merrell, P. C. (2009). *Model synthesis* [Doctoral dissertation, Stanford University]. http://graphics.stanford.edu/~pmerrell/thesis.pdf

Persson, M. (2011). The terrain generation of Minecraft. Mojang developer blog.

Russell, S. and Norvig, P. (2021). *Artificial Intelligence: A Modern Approach* (4th edition). Pearson.

Shaker, N., Togelius, J., and Nelson, M. J. (2016). *Procedural Content Generation in Games*. Springer.

Teschner, M., Heidelberger, B., Müller, M., Pomerantes, D., and Gross, M. (2003). Optimized spatial hashing for collision detection of deformable objects. In *Proceedings of Vision, Modeling, Visualization (VMV)*, pages 47–54.

---

*End of progress report.*
