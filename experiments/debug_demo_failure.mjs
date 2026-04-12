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

async function main() {
  const rules = await loadSummerRules();
  const logs = [];
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
  }, {
    log: message => logs.push({ t: performance.now(), message }),
  });

  let now = 0;
  function advanceFrames(frameCount = 1) {
    for (let i = 0; i < frameCount; i++) {
      now += 16;
      world.process(now);
    }
  }

  function advanceUntilSettled(maxFrames = 500) {
    let stable = 0;
    for (let i = 0; i < maxFrames; i++) {
      advanceFrames(1);
      if (!world.activeJob && world.queue.length === 0) {
        stable += 1;
        if (stable >= 3) return true;
      } else {
        stable = 0;
      }
    }
    return false;
  }

  function moveOne(dx, dy) {
    world.move(dx, dy);
    advanceFrames(1);
    if (world.queue.length > 24) advanceUntilSettled();
  }

  function moveTo(targetX, targetY) {
    while (world.player.x !== targetX) moveOne(Math.sign(targetX - world.player.x), 0);
    while (world.player.y !== targetY) moveOne(0, Math.sign(targetY - world.player.y));
    return advanceUntilSettled();
  }

  world.primeInitialView();
  advanceUntilSettled();

  const targets = buildSerpentineTargets(18, 8);
  for (const target of targets) {
    const pos = chunkCenter(world.options.chunkSize, target.cx, target.cy);
    const settled = moveTo(pos.x, pos.y);
    if (!settled) break;
    if (world.stats.generated >= 43) break;
  }

  const candidates = [
    { label: 'single', region: [1, 1, 2, 2] },
    { label: 'pair-left', region: [0, 1, 2, 2] },
    { label: 'pair-right', region: [1, 2, 2, 2] },
    { label: 'pair-up', region: [1, 1, 1, 2] },
    { label: 'pair-down', region: [1, 1, 2, 3] },
    { label: 'triplet-h', region: [0, 2, 2, 2] },
    { label: 'triplet-v', region: [1, 1, 1, 3] },
    { label: 'block-ul', region: [0, 1, 1, 2] },
    { label: 'block-ur', region: [1, 2, 1, 2] },
    { label: 'block-dl', region: [0, 1, 2, 3] },
    { label: 'block-dr', region: [1, 2, 2, 3] },
  ];

  const neighborSummary = {};
  for (const [label, coords] of Object.entries({
    left: [0, 2],
    right: [2, 2],
    top: [1, 1],
    bottom: [1, 3],
  })) {
    const chunk = world.getCommittedChunk(coords[0], coords[1]);
    neighborSummary[label] = chunk ? { present: true, checksum: chunk.checksum ?? null } : { present: false };
  }

  const results = [];
  for (const candidate of candidates) {
    const [minCx, maxCx, minCy, maxCy] = candidate.region;
    const beforeGenerated = world.stats.generated;
    const chunk = world.generateRegion(minCx, maxCx, minCy, maxCy, `debug-${candidate.label}`);
    results.push({
      label: candidate.label,
      region: candidate.region,
      succeeded: !!chunk && !!world.getCommittedChunk(1, 2),
      generatedDelta: world.stats.generated - beforeGenerated,
      targetInMemory: !!world.getMemoryChunk(1, 2),
    });
    if (world.getCommittedChunk(1, 2)) break;
  }

  console.log(JSON.stringify({
    generated: world.stats.generated,
    player: world.player,
    activeJob: world.activeJob,
    queue: world.queue,
    recentLogs: logs.slice(-20),
    neighbors: neighborSummary,
    candidateResults: results,
    fallbackChunk: !!world.generateStructuredFallbackChunk(1, 2),
  }, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
