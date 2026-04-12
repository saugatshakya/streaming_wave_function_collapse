# Demo Endurance Summary

## Scope

This test validates the presentation build in `demo.html`. The demo is intentionally locked to the stable horizontal presentation path because unrestricted 2D roaming can create surrounded-hole frontier states that are not appropriate for a live class demonstration.

The presentation path still demonstrates the required streaming behavior:

- chunks are generated on demand ahead of the player
- chunks behind the player are evicted from memory
- evicted chunks are reloaded from storage on revisit
- reloaded chunks match the originally generated chunks

## Reproduction

Run:

```bash
env DEMO_TARGET=1000 DEMO_PROGRESS=200 DEMO_SETTLE_MAX_FRAMES=1500 node experiments/run_demo_endurance.mjs
```

Output:

- JSON bundle: `experiments/demo_endurance_1000_chunks.json`

## Final Measured Result

- Generated chunks: `1000`
- Path mode: `horizontal march with periodic revisit checkpoints`
- Tile moves: `24780`
- Recorded movement segments: `1009`
- Unique player chunks visited: `999`
- Final player position: `(9995, 15)`

## Time Analysis

### Empirical

- Total generation time: `37427.48 ms`
- Average per generated chunk: `37.43 ms`
- 95th percentile per generated chunk: `64.57 ms`
- Maximum generated chunk time: `203.99 ms`
- Failed generations: `0`

### Structural interpretation

- Boundary seeding inspects chunk cells and boundary constraints, giving `O(G^2 * T)` preprocessing for chunk size `G` and tile count `T`.
- Storage reload reconstructs a persisted grid, giving `O(G^2)`.
- The WFC solve step remains exponential in the worst case, written conservatively as `O(T^(G^2))`.
- In the tested demo build, the observed average stayed stable enough for a presentation, but it does **not** meet the earlier `16 ms/chunk` target on this configuration.

## Memory Analysis

### Empirical

- Current memory at end: `8` chunks
- Peak memory: `9` chunks
- Peak queue length: `2`
- Total evictions: `2422`
- Total storage loads: `3858`
- Approximate peak tile slots in memory: `900`
- Local storage entries after run: `1000`

### Structural interpretation

- Active memory cost is `O(M * G^2)`, where `M` is the in-memory chunk cap.
- In this demo, `M` stayed bounded at about `9` chunks, so memory use remained flat even while world size grew to `1000` generated chunks.
- Persistent storage grows linearly with generated chunks, so storage usage is `O(N * G^2)` for `N` generated chunks.

## Correctness Checks

- Seam violations: `0`
- Internal violations: `0`
- Revisit reload checks passed: `5`
- Revisit reload checks failed: `0`
- Aggregate reload checksum matches: `3858`
- Aggregate reload checksum mismatches: `0`

Each revisit checkpoint confirmed:

- the target chunk had been evicted from memory
- the chunk was reloaded from storage
- the checksum matched the original generated chunk

## Conclusion

For the presentation build, the demo is now reliable on the tested horizontal path:

- generation ahead works
- eviction behind works
- persistence and reload correctness work
- memory remains bounded while total world size grows

This is sufficient for the live demo story. For the final report, state clearly that the presentation build is a constrained demo mode chosen for reliability, while unrestricted 2D streaming remains a harder algorithmic case.
