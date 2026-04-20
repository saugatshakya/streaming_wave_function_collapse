# Demo Script

1. Open `demo.html`.
2. State the fixed live configuration:
   - seed `20260330`
   - chunk size `10`
   - viewport `8 x 8`
   - cache limit `12`
   - no halo: `h = 0`
   - backtracking-first live solve
3. Explain the goal of the demo:
   - generate chunks ahead
   - evict chunks behind
   - reload the same chunk when revisiting
4. Point out the three things to watch:
   - the viewport
   - the event log
   - the live counters
5. Move right until new chunks are generated ahead.
6. Move further so older chunks are evicted from active memory.
7. Move back toward a previously visited area.
8. Point out the storage reload event and explain that the same chunk is being recovered from persistent storage.
9. State the core correctness message:
   - seam correctness is preserved
   - internal correctness is preserved
   - revisit identity is preserved
10. Close with the main performance statement:
   - the selected live configuration achieved `1.25 ms` mean and `1.66 ms` p95 chunk-generation time in the canonical 1000-chunk four-direction endurance run.
