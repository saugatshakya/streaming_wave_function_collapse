import { loadSummerRules } from './rules.js';
import { WFCSolver } from './solver.js';
import { hashCoords } from './rng.js';
import { validateChunkAgainstNeighbors, validateChunkInternal } from './validators.js';

const PRESET = Object.freeze({
  seed: 20260330,
  chunkSize: 10,
  viewportWidth: 8,
  viewportHeight: 8,
  memoryLimit: 8,
  frontierTrigger: 2,
  renderPadding: 4,
  queueDelayMs: 50,
  chunkSolveMs: 90,
  restartSolveMs: 140,
  deepSolveMs: 280,
});

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

function reverseAllowedTiles(rules, direction, committedTile) {
  const allowed = new Set();
  for (let tile = 0; tile < rules.tileCount; tile++) {
    if (rules.propagator[direction][tile].includes(committedTile)) allowed.add(tile);
  }
  return allowed;
}

function fallbackColor(name) {
  if (name.startsWith('water')) return '#3fa7f0';
  if (name.startsWith('road')) return '#d9be7c';
  if (name.startsWith('cliff')) return '#70411f';
  return '#65b93c';
}

function drawTile(ctx, tile, x, y, size) {
  if (tile?.image) ctx.drawImage(tile.image, x, y, size, size);
  else {
    ctx.fillStyle = fallbackColor(tile?.name || 'grass');
    ctx.fillRect(x, y, size, size);
  }
}

function checksumGrid(grid) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < grid.length; i++) {
    hash ^= grid[i] + 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

export class DemoWorld {
  constructor(rules, options, hooks = {}) {
    this.rules = rules;
    this.options = { ...PRESET, ...options };
    this.hooks = hooks;
    this.memory = new Map();
    this.queue = [];
    this.queueSet = new Set();
    this.activeJob = null;
    this.player = {
      x: Math.floor(this.options.chunkSize * 1.5),
      y: Math.floor(this.options.chunkSize * 1.5),
    };
    this.activeDirection = 'right';
    this.storagePrefix = `streaming-wfc-demo:${this.options.seed}:chunk${this.options.chunkSize}:`;
    this.stats = {
      generated: 0,
      storageLoads: 0,
      evictions: 0,
      seamViolations: 0,
      internalViolations: 0,
      failedGenerations: 0,
      peakMemory: 0,
      peakQueue: 0,
      totalSolveTimeMs: 0,
      maxSolveTimeMs: 0,
      generatedChunkRecords: [],
      reloadChecks: { matches: 0, mismatches: 0 },
      movementSteps: 0,
      uniqueVisitedChunks: new Set(),
    };
    this.chunkChecksums = new Map();
    this.eventHistory = [];
    this.status = 'Ready';
    this.grassTile = this.rules.tiles.findIndex(tile => tile.name === 'grass');
  }

  key(cx, cy) {
    return `${cx},${cy}`;
  }

  log(message) {
    this.eventHistory.push({ time: typeof performance !== 'undefined' ? performance.now() : 0, message });
    if (this.hooks.log) this.hooks.log(message);
  }

  setStatus(message) {
    this.status = message;
    if (this.hooks.status) this.hooks.status(message);
  }

  chunkCoordsForTile(x, y) {
    return {
      cx: Math.floor(x / this.options.chunkSize),
      cy: Math.floor(y / this.options.chunkSize),
    };
  }

  storageKey(cx, cy) {
    return `${this.storagePrefix}${cx},${cy}`;
  }

  getStoredChunkRaw(cx, cy) {
    try {
      const raw = localStorage.getItem(this.storageKey(cx, cy));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.grid)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  saveChunk(chunk) {
    localStorage.setItem(this.storageKey(chunk.cx, chunk.cy), JSON.stringify({
      cx: chunk.cx,
      cy: chunk.cy,
      size: chunk.size,
      grid: chunk.grid,
      seed: chunk.seed,
    }));
  }

  getMemoryChunk(cx, cy) {
    return this.memory.get(this.key(cx, cy)) || null;
  }

  touchChunk(chunk) {
    const key = this.key(chunk.cx, chunk.cy);
    if (this.memory.has(key)) this.memory.delete(key);
    this.memory.set(key, chunk);
    this.stats.peakMemory = Math.max(this.stats.peakMemory, this.memory.size);
  }

  getCommittedChunk(cx, cy) {
    const mem = this.getMemoryChunk(cx, cy);
    if (mem?.grid) return mem;
    const stored = this.getStoredChunkRaw(cx, cy);
    if (!stored?.grid) return null;
    return { ...stored, state: 'storage-only' };
  }

  loadChunkFromStorage(cx, cy) {
    const stored = this.getStoredChunkRaw(cx, cy);
    if (!stored?.grid) return null;
    const checksum = checksumGrid(stored.grid);
    const key = this.key(cx, cy);
    const expected = this.chunkChecksums.get(key);
    if (expected === checksum) this.stats.reloadChecks.matches += 1;
    else if (expected !== undefined) this.stats.reloadChecks.mismatches += 1;
    const chunk = {
      ...stored,
      size: this.options.chunkSize,
      state: 'ready',
      loadSource: 'storage',
      flashUntil: performance.now() + 650,
      flashType: 'storage',
      checksum,
    };
    this.touchChunk(chunk);
    this.stats.storageLoads += 1;
    this.log(`storage load ${cx},${cy}`);
    return chunk;
  }

  tileFromCommittedWorld(x, y) {
    const { cx, cy } = this.chunkCoordsForTile(x, y);
    const chunk = this.getCommittedChunk(cx, cy);
    if (!chunk?.grid) return null;
    const lx = ((x % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
    const ly = ((y % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
    return chunk.grid[lx + ly * this.options.chunkSize];
  }

  buildSeededCellsForRegion(minCx, maxCx, minCy, maxCy) {
    const size = this.options.chunkSize;
    const width = (maxCx - minCx + 1) * size;
    const height = (maxCy - minCy + 1) * size;
    const startX = minCx * size;
    const startY = minCy * size;
    const seeded = new Map();

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = x + y * width;
        const wx = startX + x;
        const wy = startY + y;
        const fixedTile = this.tileFromCommittedWorld(wx, wy);
        if (fixedTile !== null && fixedTile !== undefined) {
          seeded.set(index, new Set([fixedTile]));
          continue;
        }

        let allowed = null;
        for (let d = 0; d < 4; d++) {
          const nx = wx + DX[d];
          const ny = wy + DY[d];
          const neighborInsideRegion =
            nx >= startX && nx < startX + width &&
            ny >= startY && ny < startY + height;
          if (neighborInsideRegion) continue;
          const committed = this.tileFromCommittedWorld(nx, ny);
          if (committed === null || committed === undefined) continue;
          const directionAllowed = reverseAllowedTiles(this.rules, d, committed);
          allowed = allowed
            ? new Set([...allowed].filter(tile => directionAllowed.has(tile)))
            : directionAllowed;
        }
        if (allowed && allowed.size > 0) seeded.set(index, allowed);
      }
    }

    return { seeded, width, height, startX, startY };
  }

  buildSeededCells(cx, cy) {
    return this.buildSeededCellsForRegion(cx, cx, cy, cy).seeded;
  }

  solverAttempts(seed, seededCells, width, height) {
    const singleChunkArea = this.options.chunkSize * this.options.chunkSize;
    const areaScale = Math.max(1, (width * height) / singleChunkArea);
    const backtrackingBudget = Math.min(
      Math.round(this.options.chunkSolveMs * areaScale),
      this.options.chunkSolveMs * 2
    );
    const restartBudget = Math.min(
      Math.round(this.options.restartSolveMs * areaScale),
      this.options.restartSolveMs * 2
    );
    const deepBudget = Math.min(
      Math.round(this.options.deepSolveMs * areaScale),
      this.options.deepSolveMs * 2
    );
    return [
      { mode: 'backtracking', maxTimeMs: backtrackingBudget },
      { mode: 'restart', maxRestarts: 24, maxTimeMs: restartBudget },
      { mode: 'backtracking', maxTimeMs: deepBudget },
    ].map(config => new WFCSolver({
      width,
      height,
      rules: this.rules,
      seed,
      seededCells,
      ...config,
    }).solve());
  }

  fallbackRegionCandidates(cx, cy) {
    return [{ minCx: cx, maxCx: cx, minCy: cy, maxCy: cy, label: 'single' }];
  }

  tilesCompatible(tile, direction, neighborTile) {
    return this.rules.propagator[direction][tile].includes(neighborTile);
  }

  fallbackCellOptions(cx, cy, x, y, grid) {
    const size = this.options.chunkSize;
    const worldX = cx * size + x;
    const worldY = cy * size + y;
    const options = [];

    for (let tile = 0; tile < this.rules.tileCount; tile++) {
      let ok = true;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx >= 0 && ny >= 0 && nx < size && ny < size) {
          const neighborIndex = nx + ny * size;
          const neighborTile = grid[neighborIndex];
          if (neighborTile !== -1 && !this.tilesCompatible(tile, d, neighborTile)) {
            ok = false;
            break;
          }
        } else {
          const committed = this.tileFromCommittedWorld(worldX + DX[d], worldY + DY[d]);
          if (committed !== null && committed !== undefined && !this.tilesCompatible(tile, d, committed)) {
            ok = false;
            break;
          }
        }
      }
      if (ok) options.push(tile);
    }

    options.sort((a, b) => {
      if (a === this.grassTile && b !== this.grassTile) return -1;
      if (b === this.grassTile && a !== this.grassTile) return 1;
      return this.rules.weights[b] - this.rules.weights[a];
    });
    return options;
  }

  generateStructuredFallbackChunk(cx, cy) {
    if (this.grassTile < 0) return null;
    const size = this.options.chunkSize;
    const grid = new Array(size * size).fill(-1);
    const start = performance.now();
    const deadline = start + Math.max(80, this.options.deepSolveMs);
    let backtracks = 0;

    const search = () => {
      if (performance.now() > deadline) return false;
      let bestIndex = -1;
      let bestOptions = null;
      for (let index = 0; index < grid.length; index++) {
        if (grid[index] !== -1) continue;
        const x = index % size;
        const y = Math.floor(index / size);
        const options = this.fallbackCellOptions(cx, cy, x, y, grid);
        if (options.length === 0) return false;
        if (!bestOptions || options.length < bestOptions.length) {
          bestIndex = index;
          bestOptions = options;
          if (options.length === 1) break;
        }
      }

      if (bestIndex === -1) return true;
      for (const tile of bestOptions) {
        grid[bestIndex] = tile;
        if (search()) return true;
        grid[bestIndex] = -1;
        backtracks += 1;
      }
      return false;
    };

    if (!search()) return null;
    const elapsed = performance.now() - start;
    return {
      cx,
      cy,
      size,
      seed: hashCoords(this.options.seed, cx, cy, 17),
      grid,
      state: 'ready',
      loadSource: 'generated',
      flashUntil: performance.now() + 650,
      flashType: 'generated',
      checksum: checksumGrid(grid),
      metrics: {
        mode: 'structured-fallback',
        attempts: 1,
        backtracks,
        contradictions: backtracks,
      },
      elapsedMs: elapsed,
    };
  }

  finalizeGeneratedChunk(chunk, elapsedMs, solveMetrics) {
    const neighbors = {
      left: this.getCommittedChunk(chunk.cx - 1, chunk.cy),
      right: this.getCommittedChunk(chunk.cx + 1, chunk.cy),
      top: this.getCommittedChunk(chunk.cx, chunk.cy - 1),
      bottom: this.getCommittedChunk(chunk.cx, chunk.cy + 1),
    };
    const internal = validateChunkInternal(chunk.grid, chunk.size, this.rules);
    const seam = validateChunkAgainstNeighbors(chunk, neighbors, this.rules);
    if (!internal.ok) this.stats.internalViolations += internal.violations.length;
    if (!seam.ok) this.stats.seamViolations += seam.violations.length;

    this.touchChunk(chunk);
    this.saveChunk(chunk);
    this.stats.generated += 1;
    this.stats.totalSolveTimeMs += elapsedMs;
    this.stats.maxSolveTimeMs = Math.max(this.stats.maxSolveTimeMs, elapsedMs);
    this.stats.generatedChunkRecords.push({
      cx: chunk.cx,
      cy: chunk.cy,
      elapsedMs,
      mode: solveMetrics?.mode || 'unknown',
      attempts: solveMetrics?.attempts ?? 0,
      backtracks: solveMetrics?.backtracks ?? 0,
      contradictions: solveMetrics?.contradictions ?? 0,
      checksum: chunk.checksum,
    });
    this.chunkChecksums.set(this.key(chunk.cx, chunk.cy), chunk.checksum);
    this.log(`generated chunk ${chunk.cx},${chunk.cy}`);
  }

  generateRegion(minCx, maxCx, minCy, maxCy, label = 'region') {
    const size = this.options.chunkSize;
    const region = this.buildSeededCellsForRegion(minCx, maxCx, minCy, maxCy);
    let seed = hashCoords(this.options.seed, minCx, minCy, 17);
    seed = hashCoords(seed, maxCx, maxCy, 53);
    seed = hashCoords(seed, region.width, region.height, 79);
    const solveStart = performance.now();

    let solved = null;
    let solveMetrics = null;
    for (const result of this.solverAttempts(seed, region.seeded, region.width, region.height)) {
      if (result.grid) {
        solved = result;
        solveMetrics = result.metrics;
        break;
      }
    }
    const elapsed = performance.now() - solveStart;
    if (!solved?.grid) return null;

    const produced = [];
    const perChunkElapsed = produced.length > 0 ? elapsed / produced.length : elapsed;
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (this.getCommittedChunk(cx, cy)) continue;
        const baseX = (cx - minCx) * size;
        const baseY = (cy - minCy) * size;
        const grid = new Array(size * size);
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const source = (baseX + x) + (baseY + y) * region.width;
            grid[x + y * size] = solved.grid[source];
          }
        }
        const chunkSeed = hashCoords(this.options.seed, cx, cy, 17);
        const chunk = {
          cx,
          cy,
          size,
          seed: chunkSeed,
          grid,
          state: 'ready',
          loadSource: 'generated',
          flashUntil: performance.now() + 650,
          flashType: 'generated',
          checksum: checksumGrid(grid),
          metrics: solveMetrics,
        };
        produced.push(chunk);
      }
    }

    if (produced.length === 0) return this.getMemoryChunk(minCx, minCy) || null;
    for (const chunk of produced) this.finalizeGeneratedChunk(chunk, perChunkElapsed, solveMetrics);
    this.log(`generated ${label} ${minCx}:${maxCx},${minCy}:${maxCy}`);
    return produced;
  }

  generateChunk(cx, cy) {
    for (const candidate of this.fallbackRegionCandidates(cx, cy)) {
      const generated = this.generateRegion(
        candidate.minCx,
        candidate.maxCx,
        candidate.minCy,
        candidate.maxCy,
        candidate.label
      );
      if (generated) {
        return this.getMemoryChunk(cx, cy) || this.loadChunkFromStorage(cx, cy);
      }
    }

    const fallback = this.generateStructuredFallbackChunk(cx, cy);
    if (fallback) {
      this.finalizeGeneratedChunk(fallback, fallback.elapsedMs, fallback.metrics);
      this.log(`generated fallback ${cx},${cy}`);
      return fallback;
    }

    this.stats.failedGenerations += 1;
    return null;
  }

  visibleChunkRange() {
    const halfW = Math.floor(this.options.viewportWidth / 2);
    const halfH = Math.floor(this.options.viewportHeight / 2);
    const startX = this.player.x - halfW;
    const startY = this.player.y - halfH;
    const endX = startX + this.options.viewportWidth - 1;
    const endY = startY + this.options.viewportHeight - 1;
    return {
      min: this.chunkCoordsForTile(startX, startY),
      max: this.chunkCoordsForTile(endX, endY),
    };
  }

  chunkDistanceToPlayer(cx, cy) {
    const p = this.chunkCoordsForTile(this.player.x, this.player.y);
    return Math.abs(cx - p.cx) + Math.abs(cy - p.cy);
  }

  orderedVisibleMissingChunks() {
    const range = this.visibleChunkRange();
    const missing = [];
    for (let cy = range.min.cy; cy <= range.max.cy; cy++) {
      for (let cx = range.min.cx; cx <= range.max.cx; cx++) {
        if (!this.getMemoryChunk(cx, cy) && !this.queueSet.has(this.key(cx, cy))) {
          missing.push({ cx, cy });
        }
      }
    }
    missing.sort((a, b) => this.chunkDistanceToPlayer(a.cx, a.cy) - this.chunkDistanceToPlayer(b.cx, b.cy));
    return missing;
  }

  frontierCandidate() {
    const range = this.visibleChunkRange();
    const localX = ((this.player.x % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
    const localY = ((this.player.y % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
    if (this.activeDirection === 'right' && (this.options.chunkSize - 1) - localX <= this.options.frontierTrigger) {
      return { cx: range.max.cx + 1, cy: this.chunkCoordsForTile(this.player.x, this.player.y).cy };
    }
    if (this.activeDirection === 'left' && localX <= this.options.frontierTrigger) {
      return { cx: range.min.cx - 1, cy: this.chunkCoordsForTile(this.player.x, this.player.y).cy };
    }
    if (this.activeDirection === 'down' && (this.options.chunkSize - 1) - localY <= this.options.frontierTrigger) {
      return { cx: this.chunkCoordsForTile(this.player.x, this.player.y).cx, cy: range.max.cy + 1 };
    }
    if (this.activeDirection === 'up' && localY <= this.options.frontierTrigger) {
      return { cx: this.chunkCoordsForTile(this.player.x, this.player.y).cx, cy: range.min.cy - 1 };
    }
    return null;
  }

  enqueueChunk(cx, cy, reason) {
    const key = this.key(cx, cy);
    if (this.getMemoryChunk(cx, cy) || this.queueSet.has(key)) return;
    this.queue.push({ cx, cy, reason });
    this.queueSet.add(key);
    this.stats.peakQueue = Math.max(this.stats.peakQueue, this.queue.length);
    this.log(`queued ${reason} ${cx},${cy}`);
  }

  updateQueue() {
    for (const chunk of this.orderedVisibleMissingChunks()) {
      this.enqueueChunk(chunk.cx, chunk.cy, 'visible');
    }
    const frontier = this.frontierCandidate();
    if (frontier) this.enqueueChunk(frontier.cx, frontier.cy, 'frontier');
  }

  primeInitialView() {
    const initial = this.orderedVisibleMissingChunks();
    for (const { cx, cy } of initial) {
      if (this.loadChunkFromStorage(cx, cy)) continue;
      this.generateChunk(cx, cy);
    }
    this.pruneMemory();
  }

  move(dx, dy) {
    this.player.x += dx;
    this.player.y += dy;
    this.stats.movementSteps += 1;
    if (dx === 1) this.activeDirection = 'right';
    else if (dx === -1) this.activeDirection = 'left';
    else if (dy === 1) this.activeDirection = 'down';
    else if (dy === -1) this.activeDirection = 'up';
    const playerChunk = this.chunkCoordsForTile(this.player.x, this.player.y);
    this.stats.uniqueVisitedChunks.add(this.key(playerChunk.cx, playerChunk.cy));
    this.log(`move ${dx},${dy} -> ${this.player.x},${this.player.y}`);
    this.updateQueue();
    this.pruneMemory();
  }

  pruneMemory() {
    const retain = new Set();
    const range = this.visibleChunkRange();
    for (let cy = range.min.cy; cy <= range.max.cy; cy++) {
      for (let cx = range.min.cx; cx <= range.max.cx; cx++) retain.add(this.key(cx, cy));
    }
    const frontier = this.frontierCandidate();
    if (frontier) retain.add(this.key(frontier.cx, frontier.cy));
    if (this.activeJob) retain.add(this.key(this.activeJob.cx, this.activeJob.cy));

    const removable = [...this.memory.values()]
      .filter(chunk => !retain.has(this.key(chunk.cx, chunk.cy)))
      .sort((a, b) => this.chunkDistanceToPlayer(b.cx, b.cy) - this.chunkDistanceToPlayer(a.cx, a.cy));

    while (this.memory.size > this.options.memoryLimit && removable.length > 0) {
      const chunk = removable.shift();
      this.memory.delete(this.key(chunk.cx, chunk.cy));
      this.stats.evictions += 1;
      this.log(`evicted chunk ${chunk.cx},${chunk.cy}`);
    }
  }

  process(now) {
    this.updateQueue();
    if (!this.activeJob && this.queue.length > 0) {
      const job = this.queue.shift();
      this.activeJob = { ...job, startedAt: now };
      this.queueSet.delete(this.key(job.cx, job.cy));
      this.setStatus(`Preparing chunk ${job.cx},${job.cy}…`);
      return;
    }

    if (!this.activeJob) {
      this.setStatus('Idle. Move toward chunk edges to trigger new generation.');
      return;
    }

    if (now - this.activeJob.startedAt < this.options.queueDelayMs) return;

    const { cx, cy } = this.activeJob;
    let chunk = this.loadChunkFromStorage(cx, cy);
    if (!chunk) chunk = this.generateChunk(cx, cy);

    if (chunk) {
      this.setStatus(`Chunk ${cx},${cy} ready.`);
    } else {
      this.setStatus(`Chunk ${cx},${cy} failed. Move again to retry.`);
      this.log(`failed chunk ${cx},${cy}`);
    }
    this.activeJob = null;
    this.pruneMemory();
  }

  renderWindow() {
    const halfW = Math.floor(this.options.viewportWidth / 2);
    const halfH = Math.floor(this.options.viewportHeight / 2);
    const startX = this.player.x - halfW;
    const startY = this.player.y - halfH;
    const pad = this.options.renderPadding;
    return {
      x: startX - pad,
      y: startY - pad,
      width: this.options.viewportWidth + pad * 2,
      height: this.options.viewportHeight + pad * 2,
      viewportX: pad,
      viewportY: pad,
    };
  }

  render(canvas) {
    const frame = this.renderWindow();
    const tileSize = 28;
    const ctx = canvas.getContext('2d');
    canvas.width = frame.width * tileSize;
    canvas.height = frame.height * tileSize;
    ctx.fillStyle = '#091321';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let ty = 0; ty < frame.height; ty++) {
      for (let tx = 0; tx < frame.width; tx++) {
        const wx = frame.x + tx;
        const wy = frame.y + ty;
        const { cx, cy } = this.chunkCoordsForTile(wx, wy);
        const chunk = this.getMemoryChunk(cx, cy);
        const px = tx * tileSize;
        const py = ty * tileSize;

        if (chunk?.grid) {
          const lx = ((wx % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
          const ly = ((wy % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
          const tile = this.rules.tiles[chunk.grid[lx + ly * this.options.chunkSize]];
          drawTile(ctx, tile, px, py, tileSize);
        } else if (this.queueSet.has(this.key(cx, cy)) || (this.activeJob && this.activeJob.cx === cx && this.activeJob.cy === cy)) {
          ctx.fillStyle = 'rgba(19,31,48,0.88)';
          ctx.fillRect(px, py, tileSize, tileSize);
          ctx.strokeStyle = 'rgba(180,200,220,0.12)';
          ctx.beginPath();
          ctx.moveTo(px, py + tileSize);
          ctx.lineTo(px + tileSize, py);
          ctx.stroke();
        }
      }
    }

    for (const chunk of this.memory.values()) {
      if (chunk.flashUntil <= performance.now()) continue;
      const left = (chunk.cx * this.options.chunkSize - frame.x) * tileSize;
      const top = (chunk.cy * this.options.chunkSize - frame.y) * tileSize;
      const size = this.options.chunkSize * tileSize;
      if (left + size < 0 || top + size < 0 || left > canvas.width || top > canvas.height) continue;
      ctx.strokeStyle = chunk.flashType === 'storage' ? '#4fc88b' : '#8fd3ff';
      ctx.lineWidth = 4;
      ctx.strokeRect(left + 2, top + 2, size - 4, size - 4);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= frame.width; x++) {
      ctx.beginPath();
      ctx.moveTo(x * tileSize + 0.5, 0);
      ctx.lineTo(x * tileSize + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= frame.height; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * tileSize + 0.5);
      ctx.lineTo(canvas.width, y * tileSize + 0.5);
      ctx.stroke();
    }

    const chunkOffsetX = ((this.options.chunkSize - (frame.x % this.options.chunkSize)) % this.options.chunkSize);
    const chunkOffsetY = ((this.options.chunkSize - (frame.y % this.options.chunkSize)) % this.options.chunkSize);
    ctx.strokeStyle = 'rgba(143,211,255,0.24)';
    ctx.lineWidth = 2;
    for (let x = chunkOffsetX; x <= frame.width; x += this.options.chunkSize) {
      ctx.beginPath();
      ctx.moveTo(x * tileSize + 0.5, 0);
      ctx.lineTo(x * tileSize + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let y = chunkOffsetY; y <= frame.height; y += this.options.chunkSize) {
      ctx.beginPath();
      ctx.moveTo(0, y * tileSize + 0.5);
      ctx.lineTo(canvas.width, y * tileSize + 0.5);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.lineWidth = 4;
    ctx.strokeRect(
      frame.viewportX * tileSize + 2,
      frame.viewportY * tileSize + 2,
      this.options.viewportWidth * tileSize - 4,
      this.options.viewportHeight * tileSize - 4
    );

    const playerPx = (this.player.x - frame.x) * tileSize;
    const playerPy = (this.player.y - frame.y) * tileSize;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(playerPx + 4, playerPy + 4, tileSize - 8, tileSize - 8);
  }
}

function bootDemo() {
  const els = {
    canvas: document.getElementById('demoCanvas'),
    seed: document.getElementById('seedInput'),
    chunkSize: document.getElementById('chunkSizeInput'),
    viewportWidth: document.getElementById('viewportWidthInput'),
    viewportHeight: document.getElementById('viewportHeightInput'),
    memoryLimit: document.getElementById('memoryLimitInput'),
    frontier: document.getElementById('frontierInput'),
    status: document.getElementById('statusText'),
    stats: document.getElementById('statsGrid'),
    log: document.getElementById('logList'),
    applyPreset: document.getElementById('applyPresetBtn'),
    reset: document.getElementById('resetBtn'),
    clearStorage: document.getElementById('clearStorageBtn'),
    left: document.getElementById('leftBtn'),
    right: document.getElementById('rightBtn'),
  };

  let rules = null;
  let world = null;

  function appendLog(message) {
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    els.log.prepend(entry);
    while (els.log.children.length > 40) els.log.removeChild(els.log.lastChild);
  }

  function setStatus(message) {
    els.status.textContent = message;
  }

  function updateStats() {
    if (!world) return;
    const active = world.activeJob ? `${world.activeJob.cx},${world.activeJob.cy}` : 'idle';
    const stats = [
      ['Player', `${world.player.x}, ${world.player.y}`],
      ['In Memory', `${world.memory.size}`],
      ['Generated', `${world.stats.generated}`],
      ['Storage Loads', `${world.stats.storageLoads}`],
      ['Evictions', `${world.stats.evictions}`],
      ['Queued', `${world.queue.length}`],
      ['Active Job', active],
      ['Seam Violations', `${world.stats.seamViolations}`],
      ['Internal Violations', `${world.stats.internalViolations}`],
      ['Reload Matches', `${world.stats.reloadChecks.matches}`],
      ['Chunk Size', `${world.options.chunkSize}`],
    ];
    els.stats.innerHTML = stats.map(([label, value]) => `
      <div class="stat">
        <span class="stat-label">${label}</span>
        <span class="stat-value">${value}</span>
      </div>
    `).join('');
  }

  function demoOptionsFromInputs() {
    return {
      seed: Number(els.seed.value),
      chunkSize: Number(els.chunkSize.value),
      viewportWidth: Number(els.viewportWidth.value),
      viewportHeight: Number(els.viewportHeight.value),
      memoryLimit: Number(els.memoryLimit.value),
      frontierTrigger: Number(els.frontier.value),
    };
  }

  function clearDemoStorage() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('streaming-wfc-demo:')) keys.push(key);
    }
    for (const key of keys) localStorage.removeItem(key);
    appendLog(`cleared ${keys.length} demo storage entries`);
  }

  function applyPreset() {
    els.seed.value = PRESET.seed;
    els.chunkSize.value = PRESET.chunkSize;
    els.viewportWidth.value = PRESET.viewportWidth;
    els.viewportHeight.value = PRESET.viewportHeight;
    els.memoryLimit.value = PRESET.memoryLimit;
    els.frontier.value = PRESET.frontierTrigger;
    setStatus('Demo preset applied. Use left/right to generate ahead, evict behind, and reload identical chunks on return.');
  }

  async function resetWorld() {
    if (!rules) rules = await loadSummerRules();
    els.log.innerHTML = '';
    world = new DemoWorld(rules, demoOptionsFromInputs(), {
      log: appendLog,
      status: setStatus,
    });
    world.primeInitialView();
    updateStats();
    world.render(els.canvas);
    setStatus('Demo ready. Use left/right only on the presentation path.');
    window.__demoWorld = world;
  }

  function move(dx, dy) {
    if (!world) return;
    world.move(dx, dy);
    updateStats();
    world.render(els.canvas);
  }

  function loop(now) {
    if (world) {
      world.process(now);
      world.render(els.canvas);
      updateStats();
    }
    requestAnimationFrame(loop);
  }

  els.applyPreset.onclick = applyPreset;
  els.reset.onclick = () => { resetWorld(); };
  els.clearStorage.onclick = () => {
    clearDemoStorage();
    resetWorld();
  };
  els.left.onclick = () => move(-1, 0);
  els.right.onclick = () => move(1, 0);

  document.addEventListener('keydown', event => {
    if (event.repeat) return;
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const map = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      a: [-1, 0],
      d: [1, 0],
    };
    if (map[key]) {
      event.preventDefault();
      move(...map[key]);
    }
  });

  applyPreset();
  resetWorld();
  requestAnimationFrame(loop);
}

if (typeof document !== 'undefined') bootDemo();
