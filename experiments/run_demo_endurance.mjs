import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadSummerRules } from '../rules.js';
import { DemoWorld } from '../demo.js';

globalThis.performance = performance;
globalThis.localStorage = {
  map: new Map(),
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; },
  setItem(key, value) { this.map.set(String(key), String(value)); },
  removeItem(key) { this.map.delete(String(key)); },
  clear() { this.map.clear(); },
  key(index) { return [...this.map.keys()][index] ?? null; },
  get length() { return this.map.size; },
};

const TARGET_GENERATED = Number(process.env.DEMO_TARGET ?? 1000);
const ROW_WIDTH_CHUNKS = Number(process.env.DEMO_ROW_WIDTH ?? 18);
const CHECKPOINT_INTERVAL = Number(process.env.DEMO_CHECKPOINT ?? 200);
const PROGRESS_INTERVAL = Number(process.env.DEMO_PROGRESS ?? 100);
const SETTLE_MAX_FRAMES = Number(process.env.DEMO_SETTLE_MAX_FRAMES ?? 6000);
const PATH_MODE = process.env.DEMO_PATH ?? 'horizontal';
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  'experiments',
  process.env.DEMO_OUTPUT ?? `demo_endurance_${TARGET_GENERATED}_chunks.json`
);

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function percentile(values, pct) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[index];
}

function chunkCenter(chunkSize, cx, cy) {
  const half = Math.floor(chunkSize / 2);
  return { x: cx * chunkSize + half, y: cy * chunkSize + half };
}

function buildSerpentineTargets(rowWidth, rows) {
  const targets = [];
  for (let row = 0; row < rows; row++) {
    if (row % 2 === 0) {
      for (let col = 0; col < rowWidth; col++) targets.push({ cx: col, cy: row });
    } else {
      for (let col = rowWidth - 1; col >= 0; col--) targets.push({ cx: col, cy: row });
    }
  }
  return targets;
}

function buildHorizontalTargets(startCx, cy, count) {
  const targets = [];
  for (let offset = 0; offset < count; offset++) {
    targets.push({ cx: startCx + offset, cy });
  }
  return targets;
}

async function main() {
  const rules = await loadSummerRules();
  const world = new DemoWorld(rules, {
    seed: 20260330,
    chunkSize: 10,
    viewportWidth: 8,
    viewportHeight: 8,
    memoryLimit: 8,
    frontierTrigger: 2,
    queueDelayMs: 0,
    chunkSolveMs: 70,
    restartSolveMs: 140,
    deepSolveMs: 260,
  });

  const logs = [];
  world.hooks.log = message => {
    if (
      message.startsWith('generated chunk') ||
      message.startsWith('storage load') ||
      message.startsWith('evicted chunk') ||
      message.startsWith('failed chunk')
    ) {
      logs.push({ t: performance.now(), message });
    }
  };

  let now = 0;
  let tileMoves = 0;
  let checkpointIndex = CHECKPOINT_INTERVAL;
  let progressIndex = PROGRESS_INTERVAL;
  const revisitChecks = [];
  const movementSegments = [];

  function advanceFrames(frameCount = 4) {
    for (let i = 0; i < frameCount; i++) {
      now += 16;
      world.process(now);
    }
  }

  function advanceUntilSettled(maxFrames = SETTLE_MAX_FRAMES) {
    let stable = 0;
    for (let i = 0; i < maxFrames; i++) {
      advanceFrames(1);
      if (world.stats.generated >= progressIndex) {
        console.log(JSON.stringify({
          progress_generated: world.stats.generated,
          tile_moves: tileMoves,
          peak_memory_chunks: world.stats.peakMemory,
          evictions: world.stats.evictions,
          storage_loads: world.stats.storageLoads,
        }));
        progressIndex += PROGRESS_INTERVAL;
      }
      if (!world.activeJob && world.queue.length === 0) {
        stable += 1;
        if (stable >= 3) return;
      } else {
        stable = 0;
      }
    }
    throw new Error(JSON.stringify({
      message: 'World did not settle during endurance simulation.',
      generated: world.stats.generated,
      tileMoves: tileMoves,
      activeJob: world.activeJob,
      queueLength: world.queue.length,
      queueSample: world.queue.slice(0, 8),
      status: world.status,
      recentLogs: logs.slice(-12),
    }, null, 2));
  }

  function moveOne(dx, dy) {
    world.move(dx, dy);
    tileMoves += 1;
    advanceFrames(1);
    if (world.queue.length > 24) advanceUntilSettled();
  }

  function moveTo(targetX, targetY) {
    const start = { ...world.player };
    while (world.player.x !== targetX) moveOne(Math.sign(targetX - world.player.x), 0);
    while (world.player.y !== targetY) moveOne(0, Math.sign(targetY - world.player.y));
    advanceUntilSettled();
    movementSegments.push({
      from: start,
      to: { x: targetX, y: targetY },
      generatedAfterSegment: world.stats.generated,
      storageLoadsAfterSegment: world.stats.storageLoads,
      evictionsAfterSegment: world.stats.evictions,
    });
  }

  function runCheckpointRevisit() {
    if (world.stats.generated < checkpointIndex) return;
    const record = world.stats.generatedChunkRecords[Math.max(0, checkpointIndex - 150)];
    if (!record) return;

    const checkpointKey = world.key(record.cx, record.cy);
    const checkpointStoredBefore = world.getStoredChunkRaw(record.cx, record.cy);
    const checkpointInMemoryBefore = !!world.getMemoryChunk(record.cx, record.cy);
    const storageLoadsBefore = world.stats.storageLoads;
    const returnTo = { ...world.player };

    const checkpointPos = chunkCenter(world.options.chunkSize, record.cx, record.cy);
    moveTo(checkpointPos.x, checkpointPos.y);

    const reloadedChunk = world.getMemoryChunk(record.cx, record.cy);
    const checksumMatches = !!reloadedChunk && reloadedChunk.checksum === record.checksum;
    const storageLoadsAdded = world.stats.storageLoads - storageLoadsBefore;

    revisitChecks.push({
      generatedAtTrigger: world.stats.generated,
      checkpointChunk: checkpointKey,
      checkpointWasStored: !!checkpointStoredBefore,
      checkpointWasEvicted: !checkpointInMemoryBefore,
      storageLoadsAdded,
      checksumMatches,
    });

    moveTo(returnTo.x, returnTo.y);
    checkpointIndex += CHECKPOINT_INTERVAL;
  }

  world.primeInitialView();
  advanceUntilSettled();

  const startChunk = world.chunkCoordsForTile(world.player.x, world.player.y);
  const targets = PATH_MODE === 'serpentine'
    ? buildSerpentineTargets(ROW_WIDTH_CHUNKS, 200)
    : buildHorizontalTargets(startChunk.cx, startChunk.cy, TARGET_GENERATED + world.options.viewportWidth + 32);
  for (const target of targets) {
    if (world.stats.generated >= TARGET_GENERATED) break;
    const pos = chunkCenter(world.options.chunkSize, target.cx, target.cy);
    moveTo(pos.x, pos.y);
    runCheckpointRevisit();
  }

  if (world.stats.generated < TARGET_GENERATED) {
    throw new Error(`Only generated ${world.stats.generated} chunks before target path ended.`);
  }

  const times = world.stats.generatedChunkRecords.map(record => record.elapsedMs);
  const maxMemoryBytesApprox = world.stats.peakMemory * (world.options.chunkSize ** 2);
  const theoretical = {
    per_chunk_boundary_seeding_time: 'O(G^2 * T)',
    per_chunk_storage_reload_time: 'O(G^2)',
    per_chunk_worst_case_solver_time: 'O(T^(G^2))',
    active_memory_space: 'O(M * G^2)',
    explanation: {
      G: 'chunk size',
      T: 'tile alphabet size',
      M: 'configured in-memory chunk limit',
    },
  };

  const result = {
    generated_at: new Date().toISOString(),
    target_generated_chunks: TARGET_GENERATED,
    demo_config: {
      seed: world.options.seed,
      chunk_size: world.options.chunkSize,
      viewport_width: world.options.viewportWidth,
      viewport_height: world.options.viewportHeight,
      memory_limit_chunks: world.options.memoryLimit,
      frontier_trigger_tiles: world.options.frontierTrigger,
    },
    movement: {
      total_tile_moves: tileMoves,
      total_recorded_segments: movementSegments.length,
      unique_player_chunks_visited: world.stats.uniqueVisitedChunks.size,
      path_strategy: PATH_MODE === 'serpentine'
        ? `serpentine over ${ROW_WIDTH_CHUNKS} chunk columns with periodic revisit checkpoints`
        : 'horizontal march with periodic revisit checkpoints',
      sample_segments: movementSegments.slice(0, 12),
      final_player_position: world.player,
    },
    empirical_time: {
      generated_chunks: world.stats.generated,
      total_solve_time_ms: world.stats.totalSolveTimeMs,
      avg_per_generated_chunk_ms: average(times),
      p95_per_generated_chunk_ms: percentile(times, 95),
      max_per_generated_chunk_ms: world.stats.maxSolveTimeMs,
      failed_generations: world.stats.failedGenerations,
      generation_records_sample: world.stats.generatedChunkRecords.slice(0, 15),
    },
    empirical_memory: {
      current_memory_chunks: world.memory.size,
      peak_memory_chunks: world.stats.peakMemory,
      peak_queue_length: world.stats.peakQueue,
      total_evictions: world.stats.evictions,
      total_storage_loads: world.stats.storageLoads,
      approximate_peak_tile_slots: maxMemoryBytesApprox,
      local_storage_entries: globalThis.localStorage.length,
    },
    correctness: {
      seam_violations: world.stats.seamViolations,
      internal_violations: world.stats.internalViolations,
      reload_checks: revisitChecks,
      reload_checks_passed: revisitChecks.filter(check => check.checksumMatches && check.storageLoadsAdded > 0).length,
      reload_checks_failed: revisitChecks.filter(check => !check.checksumMatches || check.storageLoadsAdded <= 0).length,
      aggregate_reload_matches: world.stats.reloadChecks.matches,
      aggregate_reload_mismatches: world.stats.reloadChecks.mismatches,
    },
    theoretical_complexity: theoretical,
    assignment_expectation_notes: {
      source_assignments: [
        'Assignment-1-ADA2026 (1).pdf',
        'assignment_2 (1).pdf',
        'ADA2026_Assignment3 (2).pdf',
      ],
      emphasis: [
        'show all steps clearly',
        'justify time complexity from structure',
        'discuss correctness, not just runtime',
        'connect implementation choices to algorithmic trade-offs',
      ],
    },
    key_logs_sample: logs.slice(-60),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    generated: result.empirical_time.generated_chunks,
    avg_ms: result.empirical_time.avg_per_generated_chunk_ms,
    peak_memory_chunks: result.empirical_memory.peak_memory_chunks,
    evictions: result.empirical_memory.total_evictions,
    storage_loads: result.empirical_memory.total_storage_loads,
    reload_checks_passed: result.correctness.reload_checks_passed,
    reload_checks_failed: result.correctness.reload_checks_failed,
  }, null, 2));
  console.log(`Saved endurance results to ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
