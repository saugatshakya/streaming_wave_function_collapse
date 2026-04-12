import { loadSummerRules } from './rules.js';
import { drawViewport } from './renderer.js';
import { WorldManager } from './world.js';
import { StatsStore } from './stats.js';
import { hashCoords } from './rng.js';
import { WFCSolver } from './solver.js';

const stats = new StatsStore();
let rules = null;
let world = null;
let experimentRows = [];

const els = {
  canvas: document.getElementById('viewportCanvas'),
  worldSeed: document.getElementById('worldSeed'),
  cacheLimit: document.getElementById('cacheLimit'),
  chunkSize: document.getElementById('chunkSize'),
  viewportWidth: document.getElementById('viewportWidth'),
  viewportHeight: document.getElementById('viewportHeight'),
  stats: document.getElementById('statsPanel'),
  log: document.getElementById('eventLog'),
  batchBody: document.getElementById('batchBody'),
  progress: document.getElementById('progressText'),
  moveHint: document.getElementById('moveHint'),
};

const experimentState = {
  running: false,
  phase: '',
  current: 0,
  total: 0,
  phaseCurrent: 0,
  phaseTotal: 0,
  startedAt: 0,
  lastStepAt: 0,
  lastHeartbeatAt: 0,
  lastStepDurationMs: 0,
};

const DEMO_PRESET = Object.freeze({
  worldSeed: 20260330,
  cacheLimit: 12,
  chunkSize: 10,
  viewportWidth: 8,
  viewportHeight: 8,
});
const CONTROLLED_RUNS = 100;
const CONTROLLED_MAX_TIME_MS = 5000;
const DEMO_SOLVER_MAX_TIME_MS = 180;
const STATS_RENDER_INTERVAL_MS = 180;
let lastStatsRenderAt = 0;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function log(message) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
  els.log.prepend(line);
  while (els.log.children.length > 160) els.log.removeChild(els.log.lastChild);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return [h, m, s].map(v => String(v).padStart(2, '0')).join(':');
}

function updateExperimentProgress(extra = '') {
  if (!experimentState.running) return;
  const now = performance.now();
  const elapsed = now - experimentState.startedAt;
  const done = experimentState.current;
  const total = Math.max(1, experimentState.total);
  const pct = ((done / total) * 100).toFixed(1);
  const avgPerStep = done > 0 ? elapsed / done : 0;
  const remainingSteps = Math.max(0, total - done);
  const etaMs = avgPerStep * remainingSteps;
  const heartbeatAge = Date.now() - experimentState.lastHeartbeatAt;
  const status = heartbeatAge > 30000 ? 'possibly stuck' : 'running';
  els.progress.textContent =
    `Phase: ${experimentState.phase} | Phase progress: ${experimentState.phaseCurrent}/${experimentState.phaseTotal} | ` +
    `Overall: ${done}/${total} (${pct}%) | Elapsed: ${formatDuration(elapsed)} | ETA: ${formatDuration(etaMs)} | ` +
    `Last step: ${(experimentState.lastStepDurationMs / 1000).toFixed(2)}s | ` +
    `Heartbeat: ${new Date(experimentState.lastHeartbeatAt).toLocaleTimeString()} | Status: ${status}` +
    (extra ? ` | ${extra}` : '');
}

function markExperimentHeartbeat() {
  experimentState.lastHeartbeatAt = Date.now();
  updateExperimentProgress();
}

function beginExperiment(totalSteps) {
  experimentState.running = true;
  experimentState.phase = 'starting';
  experimentState.current = 0;
  experimentState.total = totalSteps;
  experimentState.phaseCurrent = 0;
  experimentState.phaseTotal = 0;
  experimentState.startedAt = performance.now();
  experimentState.lastStepAt = performance.now();
  experimentState.lastHeartbeatAt = Date.now();
  experimentState.lastStepDurationMs = 0;
  updateExperimentProgress();
}

function setExperimentPhase(name, phaseTotal) {
  experimentState.phase = name;
  experimentState.phaseCurrent = 0;
  experimentState.phaseTotal = phaseTotal;
  markExperimentHeartbeat();
}

function completeExperimentStep(extra = '') {
  const now = performance.now();
  experimentState.lastStepDurationMs = now - experimentState.lastStepAt;
  experimentState.lastStepAt = now;
  experimentState.current += 1;
  experimentState.phaseCurrent += 1;
  markExperimentHeartbeat();
  updateExperimentProgress(extra);
}

function endExperiment(message = 'Experiment complete.') {
  experimentState.running = false;
  els.progress.textContent = message;
}

function shouldLogForDemo(message) {
  return message.startsWith('move ')
    || message.startsWith('queued visible chunks')
    || message.startsWith('queued frontier chunks')
    || message.startsWith('job ready')
    || message.startsWith('storage load')
    || message.startsWith('evicted chunk')
    || message.startsWith('job failed')
    || message.startsWith('solve fallback');
}

function renderStats(force = false) {
  if (!world) return;
  const now = performance.now();
  if (!force && now - lastStatsRenderAt < STATS_RENDER_INTERVAL_MS) return;
  lastStatsRenderAt = now;
  const summary = stats.summary();
  els.stats.innerHTML = `
    <div class="stat-grid">
      <div><span>Player</span><strong>${world.player.x}, ${world.player.y}</strong></div>
      <div><span>Generated chunks</span><strong>${summary.generatedChunks}</strong></div>
      <div><span>In memory</span><strong>${world.memory.size}</strong></div>
      <div><span>Memory evictions</span><strong>${summary.memoryEvictions}</strong></div>
      <div><span>Storage loads</span><strong>${summary.storageLoads}</strong></div>
      <div><span>Queued chunks</span><strong>${world.queue.length}</strong></div>
      <div><span>Peak memory</span><strong>${world.maxObservedMemory}</strong></div>
      <div><span>Avg gen time</span><strong>${summary.avgGenerationTime.toFixed(2)} ms</strong></div>
      <div><span>Seam violations</span><strong>${summary.seamViolations}</strong></div>
      <div><span>Internal violations</span><strong>${summary.internalViolations}</strong></div>
      <div><span>Revisit consistency</span><strong>${summary.revisitConsistency ? 'PASS' : 'FAIL'}</strong></div>
      <div><span>Live solver</span><strong>BT + restart fallback</strong></div>
    </div>`;
}

function render(forceStats = false) {
  if (!world || !rules) return;
  drawViewport(els.canvas, { world, rules, tileSize: 28 });
  renderStats(forceStats);
}

async function initWorld({ preserveLog = false } = {}) {
  if (!rules) rules = await loadSummerRules();
  if (!preserveLog) els.log.innerHTML = '';
  window.__rules = rules;
  stats.reset();
  world = new WorldManager({
    rules,
    stats,
    chunkSize: Number(els.chunkSize.value),
    viewportWidth: Number(els.viewportWidth.value),
    viewportHeight: Number(els.viewportHeight.value),
    cacheLimit: Number(els.cacheLimit.value),
    worldSeed: Number(els.worldSeed.value),
    solverMaxTimeMs: DEMO_SOLVER_MAX_TIME_MS,
    demoMode: true,
    allowFallbackRestart: true,
    fallbackMaxRestarts: 48,
  });
  world.setLogger(message => {
    if (shouldLogForDemo(message)) log(message);
  });
  world.setPlayerStart(Math.floor(world.chunkSize * 2.5), Math.floor(world.chunkSize * 2.5));
  world.generateAlignedViewportBlock();
  render(true);
  els.progress.textContent = `Demo ready. Move around to generate chunks ahead, evict chunks behind, and reload the same tiles from storage on return.`;
}

function applyDemoPreset() {
  els.worldSeed.value = DEMO_PRESET.worldSeed;
  els.cacheLimit.value = DEMO_PRESET.cacheLimit;
  els.chunkSize.value = DEMO_PRESET.chunkSize;
  els.viewportWidth.value = DEMO_PRESET.viewportWidth;
  els.viewportHeight.value = DEMO_PRESET.viewportHeight;
  if (els.moveHint) els.moveHint.textContent = 'Demo preset applied. Move slowly toward chunk edges to show generation and reload.';
}

function move(dx, dy) {
  if (!world) return;
  world.move(dx, dy);
  render(true);
}

function clearPersisted() {
  const remove = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('streaming-wfc:')) remove.push(key);
  }
  remove.forEach(key => localStorage.removeItem(key));
  log(`Removed ${remove.length} persisted chunks.`);
}

function captureImage(label) {
  return { label, image: els.canvas.toDataURL('image/jpeg', 0.32) };
}

async function settle(frames = 6, ms = 24) {
  for (let i = 0; i < frames; i++) {
    await sleep(ms);
    markExperimentHeartbeat();
  }
}

async function hardResetMemory() {
  world = null;
  stats.reset();
  experimentRows = [];
  els.log.innerHTML = '';
  const ctx = els.canvas.getContext('2d');
  ctx.clearRect(0, 0, els.canvas.width, els.canvas.height);
  await sleep(250);
}

async function waitForWorldIdle(maxMs = 6000) {
  const start = performance.now();
  while (performance.now() - start < maxMs) {
    markExperimentHeartbeat();
    if (world && !world.activeJob && world.queue.length === 0) {
      await sleep(80);
      markExperimentHeartbeat();
      if (!world.activeJob && world.queue.length === 0) return true;
    }
    await sleep(80);
  }
  return false;
}

function scenarioConfigForChunk(chunkSize) {
  if (chunkSize <= 10) return { cache: 32, forward: 22, side: 6, back: 12, idle: 1500 };
  if (chunkSize <= 20) return { cache: 10, forward: 14, side: 4, back: 8, idle: 3000 };
  return { cache: 4, forward: 10, side: 3, back: 6, idle: 5000 };
}

async function runOneScenario(chunkSize) {
  await hardResetMemory();
  els.chunkSize.value = chunkSize;
  els.viewportWidth.value = 8;
  els.viewportHeight.value = 8;
  const cfg = scenarioConfigForChunk(chunkSize);
  els.cacheLimit.value = cfg.cache;
  clearPersisted();
  await initWorld({ preserveLog: false });
  world.disableStorageReads = true;

  await settle(6, 40);
  await waitForWorldIdle(cfg.idle);

  const plan = [
    ...Array(cfg.forward).fill([1, 0]),
    ...Array(cfg.side).fill([0, 1]),
    ...Array(cfg.back).fill([-1, 0]),
  ];

  setExperimentPhase(`Streaming scenario (${chunkSize}x${chunkSize})`, plan.length);
  const screenshots = [captureImage(`stream_${chunkSize}_start`)];
  const mid = Math.floor(plan.length / 2);

  for (let i = 0; i < plan.length; i++) {
    const [dx, dy] = plan[i];
    move(dx, dy);
    await waitForWorldIdle(cfg.idle);
    await settle(2, 40);
    if (i === mid) screenshots.push(captureImage(`stream_${chunkSize}_mid`));
    completeExperimentStep(`stream move ${i + 1}/${plan.length} for ${chunkSize}x${chunkSize}`);
  }

  await waitForWorldIdle(cfg.idle);
  screenshots.push(captureImage(`stream_${chunkSize}_end`));

  const summary = stats.summary();
  const revisit = world.runRevisitTest();
  return {
    chunkSize,
    viewport: { width: world.viewportWidth, height: world.viewportHeight },
    frontierTriggerTiles: world.frontierDistance,
    memoryChunkLimit: world.memoryChunkLimit,
    generatedChunks: summary.generatedChunks,
    storageLoads: summary.storageLoads,
    avgGenerationTimeMs: summary.avgGenerationTime,
    avgBacktracks: summary.avgBacktracks,
    avgAttempts: summary.avgAttempts,
    seamViolations: summary.seamViolations,
    internalViolations: summary.internalViolations,
    revisitConsistency: revisit.ok,
    revisitEvicted: revisit.evicted,
    revisitStorageLoadsAdded: revisit.storageLoadsAdded,
    peakQueue: world.maxObservedQueue,
    peakMemoryChunks: world.maxObservedMemory,
    screenshots,
    chunkRecordCount: stats.generated.length,
  };
}

async function runSolverComparison() {
  const plans = [
    { size: 10, runs: CONTROLLED_RUNS },
    { size: 20, runs: CONTROLLED_RUNS },
    { size: 30, runs: CONTROLLED_RUNS },
  ];
  const rows = [];
  els.batchBody.innerHTML = '<tr><td colspan="9">Running controlled solver comparison…</td></tr>';

  for (const plan of plans) {
    const { size, runs } = plan;
    setExperimentPhase(`Controlled solver comparison (${size}x${size})`, runs);
    let backSucc = 0;
    let backTime = 0;
    let backAttempts = 0;
    let backBacktracks = 0;
    let restartSucc = 0;
    let restartTime = 0;
    let restartAttempts = 0;

    for (let i = 0; i < runs; i++) {
      const seed = hashCoords(Number(els.worldSeed.value), size, i, 99);
      const stepStart = performance.now();
      const back = new WFCSolver({ width: size, height: size, rules, seed, mode: 'backtracking', maxTimeMs: CONTROLLED_MAX_TIME_MS }).solve();
      const restart = new WFCSolver({ width: size, height: size, rules, seed, mode: 'restart', maxRestarts: 160, maxTimeMs: CONTROLLED_MAX_TIME_MS }).solve();
      if (back.grid) backSucc += 1;
      if (restart.grid) restartSucc += 1;
      backTime += back.metrics.timeMs;
      backAttempts += back.metrics.attempts;
      backBacktracks += back.metrics.backtracks;
      restartTime += restart.metrics.timeMs;
      restartAttempts += restart.metrics.attempts;
      experimentState.lastStepDurationMs = performance.now() - stepStart;
      completeExperimentStep(`comparison run ${i + 1}/${runs} for ${size}x${size}`);
      await sleep(20);
      markExperimentHeartbeat();
    }

    const row = {
      size,
      runs,
      backSucc: (backSucc / runs) * 100,
      backTime: backTime / runs,
      backAttempts: backAttempts / runs,
      backBacktracks: backBacktracks / runs,
      restartSucc: (restartSucc / runs) * 100,
      restartTime: restartTime / runs,
      restartAttempts: restartAttempts / runs,
    };
    rows.push(row);
    stats.recordBatchComparison(row);
    renderExperimentTable(rows);
    await sleep(120);
  }

  experimentRows = rows;
  renderExperimentTable(rows);
  return rows;
}

function renderExperimentTable(rows) {
  if (!rows.length) {
    els.batchBody.innerHTML = '<tr><td colspan="9">Run the full experiment to populate this table.</td></tr>';
    return;
  }
  els.batchBody.innerHTML = rows.map(r => `
    <tr>
      <td>${r.size}×${r.size}</td>
      <td>${r.runs}</td>
      <td>${r.backSucc.toFixed(1)}%</td>
      <td>${r.backTime.toFixed(2)} ms</td>
      <td>${r.backAttempts.toFixed(2)}</td>
      <td>${r.backBacktracks.toFixed(2)}</td>
      <td>${r.restartSucc.toFixed(1)}%</td>
      <td>${r.restartTime.toFixed(2)} ms</td>
      <td>${r.restartAttempts.toFixed(2)}</td>
    </tr>`).join('');
}

async function runFullExperiment() {
  const runBtn = document.getElementById('runExperiment');
  const resetBtn = document.getElementById('resetWorld');
  const clearBtn = document.getElementById('clearStorage');
  runBtn.disabled = true;
  resetBtn.disabled = true;
  clearBtn.disabled = true;

  try {
    if (!rules) rules = await loadSummerRules();
    const movementSizes = [10, 20, 30];
    const solverPlans = [
      { size: 10, runs: CONTROLLED_RUNS },
      { size: 20, runs: CONTROLLED_RUNS },
      { size: 30, runs: CONTROLLED_RUNS },
    ];

    let totalSteps = 0;
    for (const chunkSize of movementSizes) {
      const cfg = scenarioConfigForChunk(chunkSize);
      totalSteps += cfg.forward + cfg.side + cfg.back;
    }
    totalSteps += solverPlans.reduce((sum, p) => sum + p.runs, 0);
    beginExperiment(totalSteps);

    const scenarios = [];
    for (const chunkSize of movementSizes) {
      const scenario = await runOneScenario(chunkSize);
      scenarios.push(scenario);
      await sleep(250);
    }

    const comparison = await runSolverComparison();

    const revisitSummary = {
      scenarios_tested: scenarios.length,
      passed: scenarios.filter(s => s.revisitConsistency).length,
      failed: scenarios.filter(s => !s.revisitConsistency).length,
      total_storage_loads_added: scenarios.reduce((sum, s) => sum + s.revisitStorageLoadsAdded, 0),
    };

    const payload = {
      generated_at: new Date().toISOString(),
      environment: {
        runtime: 'browser',
        world_seed: Number(els.worldSeed.value),
        tileset: 'Summer.xml',
        demo_preset: DEMO_PRESET,
        controlled_runs: CONTROLLED_RUNS,
        max_time_ms_per_solve: CONTROLLED_MAX_TIME_MS,
      },
      controlled_comparison: comparison,
      streaming_scenarios: scenarios,
      revisit_test: revisitSummary,
      figures: {
        expected_files: [
          'fig_streaming_timing_growth.png',
          'fig_bt_vs_restart_timing.png',
          'fig_attempt_count_comparison.png',
          'fig_halo_ablation_timing.png',
          'fig_backtrack_depth.png',
        ],
      },
      logs: Array.from(els.log.children).slice(0, 120).map(n => n.textContent),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'streaming_wfc_experiment_bundle.json';
    a.click();
    URL.revokeObjectURL(url);

    endExperiment('Experiment complete. JSON bundle downloaded.');
    log('Experiment bundle exported.');
  } catch (error) {
    console.error(error);
    endExperiment(`Experiment failed: ${error.message}`);
    log(`Experiment failed: ${error.message}`);
  } finally {
    runBtn.disabled = false;
    resetBtn.disabled = false;
    clearBtn.disabled = false;
  }
}

function bind() {
  document.getElementById('applyDemoPreset').onclick = () => { applyDemoPreset(); initWorld(); };
  document.getElementById('resetWorld').onclick = () => initWorld();
  document.getElementById('clearStorage').onclick = async () => { clearPersisted(); await initWorld(); };
  document.getElementById('runExperiment').onclick = runFullExperiment;

  document.getElementById('moveUp').onclick = () => move(0, -1);
  document.getElementById('moveDown').onclick = () => move(0, 1);
  document.getElementById('moveLeft').onclick = () => move(-1, 0);
  document.getElementById('moveRight').onclick = () => move(1, 0);

  document.addEventListener('keydown', event => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    if (event.repeat) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const map = {
      ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
      w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0],
    };
    if (map[key]) {
      event.preventDefault();
      move(...map[key]);
      if (els.moveHint) els.moveHint.textContent = 'Moved with keyboard controls.';
    }
  });
}

function loop(now) {
  if (world) {
    world.tick(now);
    render();
  }
  requestAnimationFrame(loop);
}

applyDemoPreset();
bind();
await initWorld();
requestAnimationFrame(loop);
