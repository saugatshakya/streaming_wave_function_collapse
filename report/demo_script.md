# Demo Script

1. Open the browser demo and click `Apply demo preset`.
2. State the fixed demo configuration:
   - seed `20260330`
   - chunk size `10`
   - viewport `8 x 8`
   - pure backtracking live path
3. Point out the three panels:
   - controls
   - streaming viewport
   - live stats and event log
4. Move right a few steps and show that new chunks stream in without seam breaks.
5. Move back toward an older area and point out that the world remains consistent.
6. Highlight the live metrics:
   - generated chunks
   - storage loads
   - seam violations
   - internal violations
   - revisit consistency
7. Explain that restart mode is not used in the live path and appears only in the offline comparison harness.
8. Close by showing the generated figures and the final JSON bundle in `experiments/`.
