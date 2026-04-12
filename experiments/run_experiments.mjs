import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import { loadSummerRules } from '../rules.js';
import { WFCSolver } from '../solver.js';
import { WorldManager } from '../world.js';
import { StatsStore } from '../stats.js';
import { hashCoords } from '../rng.js';
import { validateChunkAgainstNeighbors, validateChunkInternal } from '../validators.js';

const WORLD_SEED = 20260330;
const VIEWPORT = { width: 8, height: 8 };
const DEMO_PRESET = Object.freeze({
  world_seed: WORLD_SEED,
  cache_limit: 20,
  chunk_size: 10,
  viewport_width: 8,
  viewport_height: 8,
});
const CONTROLLED_COMPARISON_RUNS = 100;
const HALO_ABLATION_RUNS = 50;
const MAX_RESTARTS = 160;
const CONTROLLED_MAX_TIME_MS = 5000;
const STREAMING_MAX_TIME_MS = 30000;
const OUTPUT_PATH = path.resolve(process.cwd(), 'experiments', 'streaming_wfc_experiment_bundle.json');

if (!globalThis.performance) globalThis.performance = performance;

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }

  key(index) {
    return [...this.map.keys()][index] ?? null;
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  setItem(key, value) {
    this.map.set(String(key), String(value));
  }

  removeItem(key) {
    this.map.delete(String(key));
  }
}

globalThis.localStorage = new MemoryStorage();

function resetStorage() {
  globalThis.localStorage.clear();
}

function makeWorld({ rules, stats, chunkSize, cacheLimit, solverMaxTimeMs = CONTROLLED_MAX_TIME_MS }) {
  const world = new WorldManager({
    rules,
    stats,
    chunkSize,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
    cacheLimit,
    worldSeed: WORLD_SEED,
    solverMaxTimeMs,
  });
  world.setLogger(() => {});
  world.setPlayerStart(Math.floor(world.chunkSize * 2.5), Math.floor(world.chunkSize * 2.5));
  return world;
}

function mean(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[rank];
}

function sampleStd(values) {
  if (values.length <= 1) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function summarizeNumeric(values) {
  const avg = mean(values);
  const stdDev = sampleStd(values);
  const margin = values.length > 1 ? (1.96 * stdDev) / Math.sqrt(values.length) : 0;
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : 0,
    max: values.length ? Math.max(...values) : 0,
    mean: avg,
    median: median(values),
    std_dev: stdDev,
    p95: percentile(values, 95),
    ci95_low: avg - margin,
    ci95_high: avg + margin,
  };
}

function summarizeSolverSamples(samples) {
  const successes = samples.filter(sample => sample.success).length;
  const timedOut = samples.filter(sample => sample.timed_out).length;
  return {
    success_rate_pct: samples.length ? (successes / samples.length) * 100 : 0,
    timeout_rate_pct: samples.length ? (timedOut / samples.length) * 100 : 0,
    time_ms: summarizeNumeric(samples.map(sample => sample.time_ms)),
    attempts: summarizeNumeric(samples.map(sample => sample.attempts)),
    backtracks: summarizeNumeric(samples.map(sample => sample.backtracks)),
    contradictions: summarizeNumeric(samples.map(sample => sample.contradictions)),
    observations: summarizeNumeric(samples.map(sample => sample.observations)),
  };
}

function controlledComparisonSeed(size, runIndex) {
  return hashCoords(WORLD_SEED, size, runIndex, 99);
}

function regionSeed(worldSeed, minCx, minCy, maxCx, maxCy) {
  return hashCoords(worldSeed, minCx, minCy, hashCoords(maxCx, maxCy, 911));
}

function scenarioConfigForChunk(chunkSize) {
  if (chunkSize <= 10) {
    return {
      cache_limit: 20,
      move_plan: [
        ['right', 60, [1, 0]],
        ['down', 20, [0, 1]],
        ['left', 40, [-1, 0]],
        ['up', 20, [0, -1]],
        ['right', 40, [1, 0]],
        ['down', 20, [0, 1]],
        ['left', 20, [-1, 0]],
        ['up', 20, [0, -1]],
      ],
    };
  }
  if (chunkSize <= 20) {
    return {
      cache_limit: 8,
      move_plan: [
        ['right', 70, [1, 0]],
        ['down', 20, [0, 1]],
        ['left', 40, [-1, 0]],
        ['up', 20, [0, -1]],
        ['right', 30, [1, 0]],
      ],
    };
  }
  return {
    cache_limit: 4,
    move_plan: [
      ['right', 30, [1, 0]],
      ['down', 10, [0, 1]],
      ['left', 18, [-1, 0]],
      ['up', 6, [0, -1]],
      ['right', 8, [1, 0]],
    ],
  };
}

function expandMovePlan(movePlan) {
  const steps = [];
  for (const [, count, vector] of movePlan) {
    for (let i = 0; i < count; i++) steps.push(vector);
  }
  return steps;
}

function solveRegionChunkByChunk(world, region) {
  let solvedAny = false;
  for (let cy = region.minCy; cy <= region.maxCy; cy++) {
    for (let cx = region.minCx; cx <= region.maxCx; cx++) {
      if (world.getReadyChunk(cx, cy)) continue;
      const single = world.makeCoreRegion(cx, cx, cy, cy, `${region.policy}-single`);
      let solved = world.solveRegion(single, world.solverMode());
      if (!solved && Number.isFinite(world.solverMaxTimeMs)) {
        const previousCap = world.solverMaxTimeMs;
        world.solverMaxTimeMs = Number.POSITIVE_INFINITY;
        solved = world.solveRegion(single, world.solverMode());
        world.solverMaxTimeMs = previousCap;
      }
      if (!solved) throw new Error(`Headless solve failed for region ${JSON.stringify(single)}`);
      solvedAny = true;
      world.maxObservedQueue = Math.max(world.maxObservedQueue, 1);
    }
  }
  if (solvedAny) world.pruneMemory();
}

function advanceWorldUntilIdle(world, now, stepMs = 80) {
  let time = now;
  let stableChecks = 0;
  for (let i = 0; i < 4000; i++) {
    time += stepMs;
    world.tick(time);
    const idle = !world.activeJob && world.queue.length === 0;
    const visibleComplete = !world.visibleMissingRegion();
    if (idle && visibleComplete) {
      stableChecks += 1;
      if (stableChecks >= 3) {
        world.pruneMemory();
        return time;
      }
    } else {
      stableChecks = 0;
    }
  }
  throw new Error('World did not settle to an idle state during headless simulation.');
}

function cloneChunk(chunk) {
  return {
    cx: chunk.cx,
    cy: chunk.cy,
    size: chunk.size,
    seed: chunk.seed,
    grid: [...chunk.grid],
    state: 'ready',
    loadSource: 'generated',
    revealProgress: 1,
  };
}

function injectCommittedChunk(world, chunk) {
  world.memory.set(world.key(chunk.cx, chunk.cy), cloneChunk(chunk));
}

function extractSolvedCoreGrid(solvedGrid, spec, chunkSize, minCx, minCy, cx, cy) {
  const ox = spec.halo + (cx - minCx) * chunkSize;
  const oy = spec.halo + (cy - minCy) * chunkSize;
  const grid = [];
  for (let y = 0; y < chunkSize; y++) {
    for (let x = 0; x < chunkSize; x++) {
      grid.push(solvedGrid[(ox + x) + (oy + y) * spec.solveWidth]);
    }
  }
  return grid;
}

function buildTargetChunkResult({ world, grid, chunkSize, metrics, cx, cy }) {
  const chunk = {
    cx,
    cy,
    size: chunkSize,
    seed: hashCoords(WORLD_SEED, cx, cy, 17),
    grid,
    state: 'ready',
    loadSource: 'generated',
    revealProgress: 1,
    metrics,
  };
  const neighbors = {
    left: world.getReadyChunk(cx - 1, cy),
    right: world.getReadyChunk(cx + 1, cy),
    top: world.getReadyChunk(cx, cy - 1),
    bottom: world.getReadyChunk(cx, cy + 1),
  };
  return {
    chunk,
    internal: validateChunkInternal(grid, chunkSize, world.rules),
    seam: validateChunkAgainstNeighbors(chunk, neighbors, world.rules),
  };
}

function summarizeBoolean(values) {
  return {
    total: values.length,
    passed: values.filter(Boolean).length,
    failed: values.filter(value => !value).length,
  };
}

function findBoundarySeedingCase(rules) {
  for (let leftTile = 0; leftTile < rules.tileCount; leftTile++) {
    const rightAllowed = new Set(rules.propagator[0][leftTile]);
    if (!rightAllowed.size) continue;
    for (let topTile = 0; topTile < rules.tileCount; topTile++) {
      if (leftTile === topTile) continue;
      const downAllowed = new Set(rules.propagator[1][topTile]);
      const intersection = [...rightAllowed].filter(tile => downAllowed.has(tile));
      if (intersection.length === 0) continue;
      return {
        left_tile: leftTile,
        top_tile: topTile,
        direct_assignment_values: [leftTile, topTile],
        direct_assignment_fails: leftTile !== topTile,
        propagator_allowed_tiles: intersection,
        propagator_restriction_succeeds: true,
      };
    }
  }
  throw new Error('Unable to find a deterministic boundary-seeding case.');
}

async function runControlledComparison(rules) {
  console.log('Running controlled restart-vs-backtracking comparison...');
  const sizes = [10, 20, 30];
  const rows = [];

  for (const size of sizes) {
    const backtrackingSamples = [];
    const restartSamples = [];
    console.log(`  size ${size}x${size}: ${CONTROLLED_COMPARISON_RUNS} runs`);
    for (let runIndex = 0; runIndex < CONTROLLED_COMPARISON_RUNS; runIndex++) {
      const seed = controlledComparisonSeed(size, runIndex);
      const backtracking = new WFCSolver({
        width: size,
        height: size,
        rules,
        seed,
        mode: 'backtracking',
        maxTimeMs: CONTROLLED_MAX_TIME_MS,
      }).solve();
      const restart = new WFCSolver({
        width: size,
        height: size,
        rules,
        seed,
        mode: 'restart',
        maxRestarts: MAX_RESTARTS,
        maxTimeMs: CONTROLLED_MAX_TIME_MS,
      }).solve();

      backtrackingSamples.push({
        run_index: runIndex,
        seed,
        success: !!backtracking.grid,
        time_ms: backtracking.metrics.timeMs,
        attempts: backtracking.metrics.attempts,
        backtracks: backtracking.metrics.backtracks,
        contradictions: backtracking.metrics.contradictions,
        observations: backtracking.metrics.observations,
        timed_out: backtracking.metrics.timedOut,
      });
      restartSamples.push({
        run_index: runIndex,
        seed,
        success: !!restart.grid,
        time_ms: restart.metrics.timeMs,
        attempts: restart.metrics.attempts,
        backtracks: restart.metrics.backtracks,
        contradictions: restart.metrics.contradictions,
        observations: restart.metrics.observations,
        timed_out: restart.metrics.timedOut,
      });

      if ((runIndex + 1) % 10 === 0) process.stdout.write('.');
    }
    process.stdout.write('\n');

    rows.push({
      size,
      runs: CONTROLLED_COMPARISON_RUNS,
      backtracking: summarizeSolverSamples(backtrackingSamples),
      restart: summarizeSolverSamples(restartSamples),
      samples: {
        backtracking: backtrackingSamples,
        restart: restartSamples,
      },
    });
  }

  return {
    config: {
      world_seed: WORLD_SEED,
      sizes,
      runs_per_condition: CONTROLLED_COMPARISON_RUNS,
      max_restarts: MAX_RESTARTS,
      max_time_ms_per_solve: CONTROLLED_MAX_TIME_MS,
      identical_seeded_instances: true,
    },
    rows,
  };
}

async function runStreamingScenario(rules, chunkSize) {
  resetStorage();
  const stats = new StatsStore();
  const config = scenarioConfigForChunk(chunkSize);
  const world = makeWorld({
    rules,
    stats,
    chunkSize,
    cacheLimit: config.cache_limit,
    solverMaxTimeMs: STREAMING_MAX_TIME_MS,
  });

  world.disableStorageReads = true;
  world.generateAlignedViewportBlock();
  let now = 0;
  now = advanceWorldUntilIdle(world, now);

  const steps = expandMovePlan(config.move_plan);
  for (const [dx, dy] of steps) {
    world.move(dx, dy);
    now = advanceWorldUntilIdle(world, now);
  }

  world.disableStorageReads = false;
  const summary = stats.summary();
  const revisit = world.runRevisitTest();

  return {
    chunk_size: chunkSize,
    viewport: VIEWPORT,
    movement_steps: steps.length,
    path_segments: config.move_plan.map(([direction, count]) => ({ direction, count })),
    frontier_trigger_tiles: world.frontierDistance,
    memory_chunk_limit: world.memoryChunkLimit,
    generated_chunks: summary.generatedChunks,
    storage_loads: summary.storageLoads,
    avg_generation_time_ms: summary.avgGenerationTime,
    avg_backtracks: summary.avgBacktracks,
    avg_attempts: summary.avgAttempts,
    seam_violations: summary.seamViolations,
    internal_violations: summary.internalViolations,
    revisit_consistency: revisit.ok,
    revisit_evicted: revisit.evicted,
    revisit_storage_loads_added: revisit.storageLoadsAdded,
    revisit_before_tiles: revisit.before,
    revisit_after_tiles: revisit.after,
    peak_queue: world.maxObservedQueue,
    peak_memory_chunks: world.maxObservedMemory,
    chunk_record_count: stats.generated.length,
  };
}

async function runStreamingScenarios(rules) {
  console.log('Running streaming scenarios...');
  const scenarios = [];
  for (const chunkSize of [10, 20, 30]) {
    console.log(`  scenario ${chunkSize}x${chunkSize}`);
    scenarios.push(await runStreamingScenario(rules, chunkSize));
  }
  return {
    world_seed: WORLD_SEED,
    rows: scenarios,
  };
}

function buildContextChunks(rules, chunkSize, seedOffset) {
  resetStorage();
  const stats = new StatsStore();
  const world = new WorldManager({
    rules,
    stats,
    chunkSize,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
    cacheLimit: 32,
    worldSeed: seedOffset,
    solverMaxTimeMs: CONTROLLED_MAX_TIME_MS,
  });
  world.setLogger(() => {});
  const root = world.solveRegion(world.makeCoreRegion(0, 0, 0, 0, 'context-root'), 'backtracking');
  const top = world.solveRegion(world.makeCoreRegion(1, 1, 0, 0, 'context-top'), 'backtracking');
  const left = world.solveRegion(world.makeCoreRegion(0, 0, 1, 1, 'context-left'), 'backtracking');
  const chunks = [
    world.getReadyChunk(0, 0),
    world.getReadyChunk(1, 0),
    world.getReadyChunk(0, 1),
  ];
  if (!root || !top || !left || chunks.some(chunk => !chunk)) return null;
  return chunks.map(cloneChunk);
}

function runHaloTrial(rules, chunkSize, seedOffset, contextChunks, trialIndex, halo) {
  if (!contextChunks) {
    return {
      trial_index: trialIndex,
      halo,
      success: false,
      context_failed: true,
      seeded_cells: 0,
      time_ms: 0,
      attempts: 0,
      backtracks: 0,
      contradictions: 0,
      seam_ok: false,
      internal_ok: false,
    };
  }
  const stats = new StatsStore();
  const world = new WorldManager({
    rules,
    stats,
    chunkSize,
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
    cacheLimit: 16,
    worldSeed: seedOffset,
    solverMaxTimeMs: CONTROLLED_MAX_TIME_MS,
  });
  world.setLogger(() => {});
  world.halo = halo;

  for (const chunk of contextChunks) injectCommittedChunk(world, chunk);

  const minCx = 1;
  const maxCx = 1;
  const minCy = 1;
  const maxCy = 1;
  const spec = world.buildHaloSpec(minCx, maxCx, minCy, maxCy);
  const solved = new WFCSolver({
    width: spec.solveWidth,
    height: spec.solveHeight,
    rules,
    seed: regionSeed(seedOffset, minCx, minCy, maxCx, maxCy),
    seededCells: spec.seeded,
    mode: 'backtracking',
    maxTimeMs: CONTROLLED_MAX_TIME_MS,
  }).solve();

  if (!solved.grid) {
    return {
      trial_index: trialIndex,
      halo,
      success: false,
      seeded_cells: spec.seeded.size,
      time_ms: solved.metrics.timeMs,
      attempts: solved.metrics.attempts,
      backtracks: solved.metrics.backtracks,
      contradictions: solved.metrics.contradictions,
      seam_ok: false,
      internal_ok: false,
    };
  }

  const grid = extractSolvedCoreGrid(solved.grid, spec, chunkSize, minCx, minCy, 1, 1);
  const validation = buildTargetChunkResult({
    world,
    grid,
    chunkSize,
    metrics: solved.metrics,
    cx: 1,
    cy: 1,
  });

  return {
    trial_index: trialIndex,
    halo,
    success: true,
    seeded_cells: spec.seeded.size,
    time_ms: solved.metrics.timeMs,
    attempts: solved.metrics.attempts,
    backtracks: solved.metrics.backtracks,
    contradictions: solved.metrics.contradictions,
    seam_ok: validation.seam.ok,
    internal_ok: validation.internal.ok,
  };
}

async function runHaloAblation(rules) {
  console.log('Running halo ablation...');
  const rows = [];
  for (const size of [10, 20, 30]) {
    console.log(`  halo ablation ${size}x${size}: ${HALO_ABLATION_RUNS} trials per halo`);
    const halo0 = [];
    const halo2 = [];
    for (let trialIndex = 0; trialIndex < HALO_ABLATION_RUNS; trialIndex++) {
      const seedOffset = hashCoords(WORLD_SEED, size, trialIndex, 314159);
      const contextChunks = buildContextChunks(rules, size, seedOffset);
      halo0.push(runHaloTrial(rules, size, seedOffset, contextChunks, trialIndex, 0));
      halo2.push(runHaloTrial(rules, size, seedOffset, contextChunks, trialIndex, 2));
      if ((trialIndex + 1) % 10 === 0) process.stdout.write('.');
    }
    process.stdout.write('\n');
    const halo0Summary = summarizeBoolean(halo0.map(sample => sample.success));
    const halo2Summary = summarizeBoolean(halo2.map(sample => sample.success));

    rows.push({
      size,
      runs: HALO_ABLATION_RUNS,
      halo_0: {
        success_rate_pct: (halo0Summary.passed / HALO_ABLATION_RUNS) * 100,
        time_ms: summarizeNumeric(halo0.map(sample => sample.time_ms)),
        attempts: summarizeNumeric(halo0.map(sample => sample.attempts)),
        backtracks: summarizeNumeric(halo0.map(sample => sample.backtracks)),
        contradictions: summarizeNumeric(halo0.map(sample => sample.contradictions)),
        seeded_cells: summarizeNumeric(halo0.map(sample => sample.seeded_cells)),
        context_failures: halo0.filter(sample => sample.context_failed).length,
        seam_failures: halo0.filter(sample => !sample.seam_ok).length,
        internal_failures: halo0.filter(sample => !sample.internal_ok).length,
      },
      halo_2: {
        success_rate_pct: (halo2Summary.passed / HALO_ABLATION_RUNS) * 100,
        time_ms: summarizeNumeric(halo2.map(sample => sample.time_ms)),
        attempts: summarizeNumeric(halo2.map(sample => sample.attempts)),
        backtracks: summarizeNumeric(halo2.map(sample => sample.backtracks)),
        contradictions: summarizeNumeric(halo2.map(sample => sample.contradictions)),
        seeded_cells: summarizeNumeric(halo2.map(sample => sample.seeded_cells)),
        context_failures: halo2.filter(sample => sample.context_failed).length,
        seam_failures: halo2.filter(sample => !sample.seam_ok).length,
        internal_failures: halo2.filter(sample => !sample.internal_ok).length,
      },
      samples: {
        halo_0: halo0,
        halo_2: halo2,
      },
    });
  }
  return {
    config: {
      sizes: [10, 20, 30],
      runs_per_halo: HALO_ABLATION_RUNS,
      target_region: { cx: 1, cy: 1 },
      fixed_boundary_context: true,
    },
    rows,
  };
}

function summarizeRevisit(rows) {
  const results = rows.map(row => row.revisit_consistency);
  return {
    scenarios_tested: rows.length,
    passed: results.filter(Boolean).length,
    failed: results.filter(value => !value).length,
    all_evicted_before_revisit: rows.every(row => row.revisit_evicted),
    total_storage_loads_added: rows.reduce((sum, row) => sum + row.revisit_storage_loads_added, 0),
  };
}

async function main() {
  console.log('Loading Summer.xml rules...');
  const rules = await loadSummerRules();
  const requestedPhases = new Set(
    (process.env.WFC_PHASES || 'comparison,streaming,halo,boundary')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
  );

  const controlledComparison = requestedPhases.has('comparison')
    ? await runControlledComparison(rules)
    : null;
  const streamingScenarios = requestedPhases.has('streaming')
    ? await runStreamingScenarios(rules)
    : null;
  const haloAblation = requestedPhases.has('halo')
    ? await runHaloAblation(rules)
    : null;
  const boundarySeedingCase = requestedPhases.has('boundary')
    ? findBoundarySeedingCase(rules)
    : null;

  const payload = {
    generated_at: new Date().toISOString(),
    environment: {
      runtime: 'node',
      node_version: process.version,
      platform: process.platform,
      world_seed: WORLD_SEED,
      tileset: 'Summer.xml',
      tile_variants: rules.tileCount,
      loaded_image_count: rules.loadedImageCount,
      demo_preset: DEMO_PRESET,
    },
    controlled_comparison: controlledComparison,
    streaming_scenarios: streamingScenarios,
    halo_ablation: haloAblation,
    revisit_test: streamingScenarios ? summarizeRevisit(streamingScenarios.rows) : null,
    boundary_seeding_case: boundarySeedingCase,
    figures: {
      output_dir: path.resolve(process.cwd(), 'figures'),
      expected_files: [
        'fig_streaming_timing_growth.png',
        'fig_bt_vs_restart_timing.png',
        'fig_attempt_count_comparison.png',
        'fig_halo_ablation_timing.png',
        'fig_backtrack_depth.png',
      ],
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
  console.log(`Saved canonical experiment bundle to ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
