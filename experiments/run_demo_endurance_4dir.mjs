import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { loadSummerRules } from '../rules.js';
import { WorldManager } from '../world.js';
import { StatsStore } from '../stats.js';

globalThis.performance = performance;

class MemoryStorage {
  constructor() {
    this.map = new Map();
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

  get length() {
    return this.map.size;
  }
}

globalThis.localStorage = new MemoryStorage();

const TARGET_GENERATED = Number(process.env.DEMO_TARGET ?? 1000);
const PROGRESS_INTERVAL = Number(process.env.DEMO_PROGRESS ?? 200);
const CHECKPOINT_INTERVAL = Number(process.env.DEMO_CHECKPOINT ?? 200);
const SETTLE_MAX_TICKS = Number(process.env.DEMO_SETTLE_MAX_TICKS ?? 4000);
const HALO = Number(process.env.DEMO_HALO ?? 2);
const SOLVER_MAX_TIME_MS = Number(process.env.DEMO_SOLVER_MAX_TIME_MS ?? 180);
const OUTPUT_PATH = path.resolve(
  process.cwd(),
  'experiments',
  process.env.DEMO_OUTPUT ?? `demo_endurance_4dir_${TARGET_GENERATED}_chunks.json`
);

function checksumGrid(grid) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < grid.length; i++) {
    hash ^= grid[i] + 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

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

function* spiralChunkTargets(startCx, startCy) {
  let cx = startCx;
  let cy = startCy;
  yield { cx, cy };
  let stepLength = 1;
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];

  while (true) {
    for (let dirIndex = 0; dirIndex < dirs.length; dirIndex++) {
      const [dx, dy] = dirs[dirIndex];
      for (let i = 0; i < stepLength; i++) {
        cx += dx;
        cy += dy;
        yield { cx, cy };
      }
      if (dirIndex % 2 === 1) stepLength += 1;
    }
  }
}

function getStoredChunk(storagePrefix, cx, cy) {
  const raw = globalThis.localStorage.getItem(`${storagePrefix}${cx},${cy}`);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.grid) ? parsed : null;
}

async function main() {
  const rules = await loadSummerRules();
  const stats = new StatsStore();
  const world = new WorldManager({
    rules,
    stats,
    chunkSize: 10,
    viewportWidth: 8,
    viewportHeight: 8,
    cacheLimit: 12,
    worldSeed: 20260330,
    solverMaxTimeMs: SOLVER_MAX_TIME_MS,
    demoMode: true,
    allowFallbackRestart: true,
    fallbackMaxRestarts: 48,
  });
  world.solvePreviewMs = 0;
  world.revealDurationMs = 0;
  world.halo = HALO;

  const logs = [];
  world.setLogger(message => {
    if (
      message.startsWith('move ') ||
      message.startsWith('queued visible chunks') ||
      message.startsWith('queued frontier chunks') ||
      message.startsWith('job ready') ||
      message.startsWith('storage load') ||
      message.startsWith('evicted chunk') ||
      message.startsWith('job failed') ||
      message.startsWith('solve fallback')
    ) {
      logs.push({ t: performance.now(), message });
    }
  });

  world.setPlayerStart(Math.floor(world.chunkSize * 2.5), Math.floor(world.chunkSize * 2.5));
  world.generateAlignedViewportBlock();

  let now = 0;
  let movementSteps = 0;
  let movementSegments = 0;
  let progressThreshold = PROGRESS_INTERVAL;
  let checkpointThreshold = CHECKPOINT_INTERVAL;
  const uniqueVisitedChunks = new Set();
  const chunkChecksums = new Map();
  const reloadChecks = [];

  function recordKnownChunks() {
    for (const record of stats.generated) {
      if (record.loadSource !== 'generated') continue;
      const stored = getStoredChunk(world.storagePrefix, record.cx, record.cy);
      if (!stored?.grid) continue;
      chunkChecksums.set(world.key(record.cx, record.cy), checksumGrid(stored.grid));
    }
  }

  function advanceUntilIdle() {
    let stableChecks = 0;
    for (let i = 0; i < SETTLE_MAX_TICKS; i++) {
      now += 16;
      world.tick(now);
      recordKnownChunks();
      const idle = !world.activeJob && world.queue.length === 0;
      const visibleComplete = !world.visibleMissingRegion();
      if (idle && visibleComplete) {
        stableChecks += 1;
        if (stableChecks >= 3) {
          world.pruneMemory();
          return;
        }
      } else {
        stableChecks = 0;
      }
    }
    throw new Error(JSON.stringify({
      message: '4-direction world did not settle.',
      generated: stats.summary().generatedChunks,
      movementSteps,
      player: world.player,
      activeJob: world.activeJob,
      queueLength: world.queue.length,
      recentLogs: logs.slice(-20),
    }, null, 2));
  }

  function advanceFrames(frameCount = 2) {
    for (let i = 0; i < frameCount; i++) {
      now += 16;
      world.tick(now);
      recordKnownChunks();
    }
  }

  function moveOne(dx, dy) {
    world.move(dx, dy);
    movementSteps += 1;
    const playerChunk = world.chunkCoordsForTile(world.player.x, world.player.y);
    uniqueVisitedChunks.add(world.key(playerChunk.cx, playerChunk.cy));
    advanceFrames(2);
    if (world.queue.length > 12 || world.activeJob || world.visibleMissingRegion()) {
      advanceUntilIdle();
    }
  }

  function moveTo(targetX, targetY) {
    while (world.player.x !== targetX) moveOne(Math.sign(targetX - world.player.x), 0);
    while (world.player.y !== targetY) moveOne(0, Math.sign(targetY - world.player.y));
    advanceUntilIdle();
    movementSegments += 1;
  }

  function runRevisitCheck() {
    const generatedChunks = stats.summary().generatedChunks;
    if (generatedChunks < checkpointThreshold) return;
    const generatedOnly = stats.generated.filter(record => record.loadSource === 'generated');
    const targetRecord = generatedOnly[Math.max(0, checkpointThreshold - 150)];
    if (!targetRecord) return;

    const checkpointKey = world.key(targetRecord.cx, targetRecord.cy);
    const knownChecksum = chunkChecksums.get(checkpointKey);
    const beforeInMemory = !!world.memory.get(checkpointKey);
    const storageLoadsBefore = stats.summary().storageLoads;
    const currentPlayer = { ...world.player };

    const pos = chunkCenter(world.chunkSize, targetRecord.cx, targetRecord.cy);
    moveTo(pos.x, pos.y);

    const chunk = world.getReadyChunk(targetRecord.cx, targetRecord.cy);
    const actualChecksum = chunk?.grid ? checksumGrid(chunk.grid) : null;
    const storageLoadsAfter = stats.summary().storageLoads;
    reloadChecks.push({
      generatedAtTrigger: generatedChunks,
      checkpointChunk: checkpointKey,
      checkpointWasEvicted: !beforeInMemory,
      storageLoadsAdded: storageLoadsAfter - storageLoadsBefore,
      checksumMatches: actualChecksum !== null && knownChecksum === actualChecksum,
    });

    moveTo(currentPlayer.x, currentPlayer.y);
    checkpointThreshold += CHECKPOINT_INTERVAL;
  }

  advanceUntilIdle();
  const startChunk = world.chunkCoordsForTile(world.player.x, world.player.y);
  const targets = spiralChunkTargets(startChunk.cx, startChunk.cy);

  for (const target of targets) {
    if (stats.summary().generatedChunks >= TARGET_GENERATED) break;
    const pos = chunkCenter(world.chunkSize, target.cx, target.cy);
    moveTo(pos.x, pos.y);
    const generatedChunks = stats.summary().generatedChunks;
    if (generatedChunks >= progressThreshold) {
      const summary = stats.summary();
      console.log(JSON.stringify({
        progress_generated: summary.generatedChunks,
        movement_steps: movementSteps,
        visited_chunks: uniqueVisitedChunks.size,
        peak_memory_chunks: world.maxObservedMemory,
        evictions: summary.memoryEvictions,
        storage_loads: summary.storageLoads,
      }));
      progressThreshold += PROGRESS_INTERVAL;
    }
    runRevisitCheck();
  }

  const summary = stats.summary();
  if (summary.generatedChunks < TARGET_GENERATED) {
    throw new Error(`Only generated ${summary.generatedChunks} chunks before path exhaustion.`);
  }

  const times = stats.generated.filter(record => record.loadSource === 'generated').map(record => record.timeMs);
  const result = {
    generated_at: new Date().toISOString(),
    demo_config: {
      seed: world.worldSeed,
      chunk_size: world.chunkSize,
      viewport_width: world.viewportWidth,
      viewport_height: world.viewportHeight,
      cache_limit: world.cacheLimit,
      halo: world.halo,
      solver_mode: world.solverMode(),
      restart_fallback: world.allowFallbackRestart,
    },
    movement: {
      path_strategy: 'outward square spiral with periodic revisits',
      total_tile_moves: movementSteps,
      total_segments: movementSegments,
      unique_player_chunks_visited: uniqueVisitedChunks.size,
      final_player_position: world.player,
    },
    empirical_time: {
      generated_chunks: summary.generatedChunks,
      avg_generation_time_ms: summary.avgGenerationTime,
      p95_generation_time_ms: percentile(times, 95),
      max_generation_time_ms: times.length ? Math.max(...times) : 0,
      avg_backtracks: summary.avgBacktracks,
      avg_attempts: summary.avgAttempts,
      total_generated_time_ms: times.reduce((sum, value) => sum + value, 0),
    },
    empirical_memory: {
      current_memory_chunks: world.memory.size,
      peak_memory_chunks: world.maxObservedMemory,
      peak_queue_length: world.maxObservedQueue,
      memory_evictions: summary.memoryEvictions,
      storage_loads: summary.storageLoads,
      local_storage_entries: globalThis.localStorage.length,
      active_memory_space_complexity: 'O(M * G^2)',
      persistent_storage_space_complexity: 'O(N * G^2)',
    },
    correctness: {
      seam_violations: summary.seamViolations,
      internal_violations: summary.internalViolations,
      revisit_consistency: summary.revisitConsistency,
      reload_checks: reloadChecks,
      reload_checks_passed: reloadChecks.filter(check => check.checksumMatches && check.storageLoadsAdded > 0).length,
      reload_checks_failed: reloadChecks.filter(check => !check.checksumMatches || check.storageLoadsAdded <= 0).length,
    },
    theoretical_complexity: {
      boundary_seeding_time: 'O(G^2 * T)',
      storage_reload_time: 'O(G^2)',
      active_memory_space: 'O(M * G^2)',
      persistent_storage_space: 'O(N * G^2)',
      worst_case_solver_time: 'O(T^(G^2))',
      symbols: {
        G: 'chunk size',
        T: 'tile alphabet size',
        M: 'memory chunk limit',
        N: 'generated chunk count',
      },
    },
    recent_logs: logs.slice(-80),
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({
    generated: result.empirical_time.generated_chunks,
    avg_ms: result.empirical_time.avg_generation_time_ms,
    peak_memory_chunks: result.empirical_memory.peak_memory_chunks,
    evictions: result.empirical_memory.memory_evictions,
    storage_loads: result.empirical_memory.storage_loads,
    reload_checks_passed: result.correctness.reload_checks_passed,
    reload_checks_failed: result.correctness.reload_checks_failed,
    seam_violations: result.correctness.seam_violations,
    internal_violations: result.correctness.internal_violations,
  }, null, 2));
  console.log(`Saved 4-direction endurance results to ${OUTPUT_PATH}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
