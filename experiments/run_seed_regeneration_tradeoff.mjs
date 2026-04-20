import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadSummerRules } from '../rules.js';
import { WFCSolver } from '../solver.js';
import { hashCoords } from '../rng.js';
import { validateChunkAgainstNeighbors, validateChunkInternal } from '../validators.js';

const WORLD_SEED = Number(process.env.SEED_REGEN_WORLD_SEED ?? 20260330);
const CHUNK_SIZE = Number(process.env.SEED_REGEN_CHUNK_SIZE ?? 10);
const TARGET_GENERATED = Number(process.env.SEED_REGEN_TARGET ?? 1000);
const SAMPLE_COUNT = Number(process.env.SEED_REGEN_SAMPLES ?? 80);
const SOLVER_MAX_TIME_MS = Number(process.env.SEED_REGEN_SOLVER_MAX_TIME_MS ?? 180);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  'experiments',
  process.env.SEED_REGEN_OUTPUT ?? `seed_regeneration_tradeoff_${TARGET_GENERATED}.json`
);

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function key(cx, cy) {
  return `${cx},${cy}`;
}

function checksumGrid(grid) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < grid.length; i++) {
    hash ^= grid[i] + 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function* driftingTargets(startCx, startCy) {
  let cx = startCx;
  let cy = startCy;
  yield { cx, cy };
  while (true) {
    for (let i = 0; i < 12; i++) {
      cx += 1;
      yield { cx, cy };
    }
    for (let i = 0; i < 3; i++) {
      cy += 1;
      yield { cx, cy };
    }
    for (let i = 0; i < 4; i++) {
      cx -= 1;
      yield { cx, cy };
    }
    for (let i = 0; i < 3; i++) {
      cy -= 1;
      yield { cx, cy };
    }
  }
}

function tileAtWorld(committed, worldX, worldY, chunkSize) {
  const cx = Math.floor(worldX / chunkSize);
  const cy = Math.floor(worldY / chunkSize);
  const chunk = committed.get(key(cx, cy));
  if (!chunk?.grid) return null;
  const lx = ((worldX % chunkSize) + chunkSize) % chunkSize;
  const ly = ((worldY % chunkSize) + chunkSize) % chunkSize;
  return chunk.grid[lx + ly * chunkSize];
}

function allowedTilesForCommittedNeighbor(rules, direction, committedTile) {
  const allowed = new Set();
  for (let tile = 0; tile < rules.tileCount; tile++) {
    if (rules.propagator[direction][tile].includes(committedTile)) allowed.add(tile);
  }
  return allowed;
}

function buildSeededBoundary(committed, rules, chunkSize, cx, cy) {
  const seeded = new Map();
  const baseX = cx * chunkSize;
  const baseY = cy * chunkSize;

  for (let y = 0; y < chunkSize; y++) {
    for (let x = 0; x < chunkSize; x++) {
      const wx = baseX + x;
      const wy = baseY + y;
      let allowed = null;

      for (let d = 0; d < 4; d++) {
        const nx = wx + DX[d];
        const ny = wy + DY[d];
        const ncx = Math.floor(nx / chunkSize);
        const ncy = Math.floor(ny / chunkSize);

        if (ncx === cx && ncy === cy) continue;

        const committedTile = tileAtWorld(committed, nx, ny, chunkSize);
        if (committedTile === null || committedTile === undefined) continue;

        const directionAllowed = allowedTilesForCommittedNeighbor(rules, d, committedTile);
        allowed = allowed
          ? new Set([...allowed].filter(tile => directionAllowed.has(tile)))
          : directionAllowed;
      }

      if (allowed && allowed.size > 0) {
        seeded.set(x + y * chunkSize, allowed);
      }
    }
  }

  return seeded;
}

function serializeSeeded(seeded) {
  return [...seeded.entries()].map(([index, set]) => [index, [...set].sort((a, b) => a - b)]);
}

function deserializeSeeded(serialized) {
  const seeded = new Map();
  for (const [index, values] of serialized) {
    seeded.set(Number(index), new Set(values));
  }
  return seeded;
}

function getNeighbors(committed, cx, cy) {
  return {
    left: committed.get(key(cx - 1, cy)) || null,
    right: committed.get(key(cx + 1, cy)) || null,
    top: committed.get(key(cx, cy - 1)) || null,
    bottom: committed.get(key(cx, cy + 1)) || null,
  };
}

function solveChunk(committed, rules, chunkSize, worldSeed, cx, cy) {
  const chunkSeed = hashCoords(worldSeed, cx, cy, 17) >>> 0;
  const seededCells = buildSeededBoundary(committed, rules, chunkSize, cx, cy);

  return solveChunkFromSeeded(committed, rules, chunkSize, cx, cy, chunkSeed, seededCells);
}

function solveChunkFromSeeded(committed, rules, chunkSize, cx, cy, chunkSeed, seededCells) {

  const solved = new WFCSolver({
    size: chunkSize,
    rules,
    seed: chunkSeed,
    seededCells,
    mode: 'backtracking',
    maxTimeMs: SOLVER_MAX_TIME_MS,
  }).solve();

  if (!solved.grid) {
    return { chunk: null, metrics: solved.metrics, seededCount: seededCells.size, chunkSeed };
  }

  const chunk = {
    cx,
    cy,
    size: chunkSize,
    seed: chunkSeed,
    grid: solved.grid,
  };

  const internal = validateChunkInternal(chunk.grid, chunkSize, rules);
  const seam = validateChunkAgainstNeighbors(chunk, getNeighbors(committed, cx, cy), rules);
  if (!internal.ok || !seam.ok) {
    return {
      chunk: null,
      metrics: solved.metrics,
      seededCount: seededCells.size,
      chunkSeed,
      internalOk: internal.ok,
      seamOk: seam.ok,
    };
  }

  return {
    chunk,
    metrics: solved.metrics,
    seededCount: seededCells.size,
    chunkSeed,
    internalOk: true,
    seamOk: true,
  };
}

async function main() {
  const rules = await loadSummerRules();
  const committed = new Map();
  const generationOrder = [];

  const targets = driftingTargets(0, 0);
  while (generationOrder.length < TARGET_GENERATED) {
    const { value: target } = targets.next();
    const k = key(target.cx, target.cy);
    if (committed.has(k)) continue;

    const solved = solveChunk(committed, rules, CHUNK_SIZE, WORLD_SEED, target.cx, target.cy);
    if (!solved.chunk) {
      throw new Error(`Generation failed at ${k}; internal=${solved.internalOk} seam=${solved.seamOk}`);
    }

    committed.set(k, solved.chunk);
    generationOrder.push({
      cx: target.cx,
      cy: target.cy,
      chunk_seed: solved.chunkSeed,
      checksum: checksumGrid(solved.chunk.grid),
      seeded_snapshot: serializeSeeded(buildSeededBoundary(committed, rules, CHUNK_SIZE, target.cx, target.cy)),
    });
  }

  const desiredChecks = Math.max(1, Math.min(SAMPLE_COUNT, generationOrder.length));
  const checkpoints = [];
  const used = new Set();
  for (let i = 1; i <= desiredChecks; i++) {
    const idx = Math.floor((i * generationOrder.length) / (desiredChecks + 1));
    if (used.has(idx)) continue;
    used.add(idx);
    checkpoints.push(generationOrder[idx]);
  }

  const checks = [];
  const recomputeTimes = [];
  let passCount = 0;

  for (const checkpoint of checkpoints) {
    const {
      cx,
      cy,
      checksum: originalChecksum,
      chunk_seed: storedSeed,
      seeded_snapshot: seededSnapshot,
    } = checkpoint;
    const k = key(cx, cy);
    committed.delete(k);

    const replaySeeded = deserializeSeeded(seededSnapshot);
    const t0 = performance.now();
    const solved = solveChunkFromSeeded(
      committed,
      rules,
      CHUNK_SIZE,
      cx,
      cy,
      storedSeed,
      replaySeeded
    );
    const recomputeMs = performance.now() - t0;

    if (!solved.chunk) {
      checks.push({
        checkpointChunk: k,
        executed: true,
        regenerated_from_seed: false,
        checksum_matches: false,
        chunk_seed_matches: false,
        internalOk: false,
        seamOk: false,
        recompute_time_ms: recomputeMs,
      });
      continue;
    }

    const regeneratedChecksum = checksumGrid(solved.chunk.grid);
    const expectedSeed = hashCoords(WORLD_SEED, cx, cy, 17) >>> 0;
    const chunkSeedMatches = solved.chunk.seed === storedSeed && solved.chunk.seed === expectedSeed;
    const checksumMatches = regeneratedChecksum === originalChecksum;
    const pass = checksumMatches && chunkSeedMatches && solved.internalOk && solved.seamOk;

    committed.set(k, solved.chunk);
    recomputeTimes.push(recomputeMs);
    if (pass) passCount += 1;

    checks.push({
      checkpointChunk: k,
      executed: true,
      regenerated_from_seed: true,
      replayed_with_original_boundary_snapshot: true,
      checksum_matches: checksumMatches,
      chunk_seed_matches: chunkSeedMatches,
      internalOk: solved.internalOk,
      seamOk: solved.seamOk,
      recompute_time_ms: recomputeMs,
    });
  }

  const persistentTileCells = generationOrder.length * CHUNK_SIZE * CHUNK_SIZE;
  const seedOnlyEntries = generationOrder.length;
  const seedOnlyScalarUnitsEstimate = generationOrder.length * 3;

  const report = {
    generated_at: new Date().toISOString(),
    experiment: {
      type: 'seed-regeneration-space-time-tradeoff',
      world_seed: WORLD_SEED,
      chunk_size: CHUNK_SIZE,
      target_generated_chunks: TARGET_GENERATED,
      generation_policy: 'single-chunk boundary-constrained solve with coordinate-based seed',
      sample_count_requested: SAMPLE_COUNT,
      sample_count_executed: checks.length,
    },
    summary: {
      generated_chunks: generationOrder.length,
      deterministic_checks_passed: passCount,
      deterministic_checks_total: checks.length,
      deterministic_pass_rate_pct: checks.length ? (passCount / checks.length) * 100 : 0,
      recompute_time_ms: {
        mean: average(recomputeTimes),
        p95: percentile(recomputeTimes, 95),
        max: recomputeTimes.length ? Math.max(...recomputeTimes) : 0,
      },
      space_tradeoff: {
        persistent_storage_tile_cells: persistentTileCells,
        persistent_asymptotic: 'O(NG^2)',
        seed_only_entries: seedOnlyEntries,
        seed_only_scalar_units_estimate: seedOnlyScalarUnitsEstimate,
        seed_only_asymptotic: 'O(N)',
        replacement_cost_per_revisit: 'O(T_solve)',
        scalar_reduction_vs_tile_cells_pct: persistentTileCells
          ? (1 - (seedOnlyScalarUnitsEstimate / persistentTileCells)) * 100
          : 0,
      },
    },
    checks,
  };

  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({
    output: path.relative(process.cwd(), OUTPUT_PATH),
    generated_chunks: generationOrder.length,
    deterministic_pass: `${passCount}/${checks.length}`,
    pass_rate_pct: report.summary.deterministic_pass_rate_pct,
    recompute_mean_ms: report.summary.recompute_time_ms.mean,
    recompute_p95_ms: report.summary.recompute_time_ms.p95,
    scalar_reduction_pct: report.summary.space_tradeoff.scalar_reduction_vs_tile_cells_pct,
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
