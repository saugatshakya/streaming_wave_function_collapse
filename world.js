import { hashCoords } from './rng.js';
import { WFCSolver } from './solver.js';
import { validateChunkAgainstNeighbors, validateChunkInternal } from './validators.js';

export class WorldManager {
  constructor({
    rules,
    stats,
    chunkSize = 10,
    viewportWidth = 20,
    viewportHeight = 20,
    cacheLimit = 500,
    worldSeed = 12345,
    solverMaxTimeMs = Number.POSITIVE_INFINITY,
    demoMode = false,
    allowFallbackRestart = false,
    fallbackMaxRestarts = 48,
  }) {
    this.rules = rules;
    this.stats = stats;
    this.chunkSize = chunkSize;
    this.viewportWidth = viewportWidth;
    this.viewportHeight = viewportHeight;
    this.cacheLimit = cacheLimit;
    this.worldSeed = worldSeed >>> 0;
    this.solverMaxTimeMs = solverMaxTimeMs;
    this.demoMode = demoMode;
    this.allowFallbackRestart = allowFallbackRestart;
    this.fallbackMaxRestarts = fallbackMaxRestarts;
    this.player = { x: 0, y: 0 };
    this.activeDirection = null;
    this.memory = new Map();
    this.queue = [];
    this.activeJob = null;
    this.solvePreviewMs = 120;
    this.revealDurationMs = 220;
    this.storageVersion = 'clean-v13-final';
    this.halo = 2;
    this.disableStorageReads = false;
    this.logFn = null;
    this.maxObservedQueue = 0;
    this.maxObservedMemory = 0;
    this.computeAdaptivePolicy();
    this.storagePrefix = `streaming-wfc:${this.storageVersion}:${this.worldSeed}:chunk${this.chunkSize}:view${this.viewportWidth}x${this.viewportHeight}:`;
  }

  computeAdaptivePolicy() {
    const maxViewport = Math.max(this.viewportWidth, this.viewportHeight);
    const halfViewport = Math.ceil(maxViewport / 2);
    this.outerPaddingTiles = Math.max(4, halfViewport + 2);

    if (this.chunkSize <= 10) {
      this.frontierDistance = Math.max(3, halfViewport + 1);
      this.memoryKeepRadius = 1;
      this.memoryChunkLimit = Math.min(this.cacheLimit, 20);
      this.solvePreviewMs = this.demoMode ? 18 : 80;
      this.revealDurationMs = this.demoMode ? 60 : 160;
    } else if (this.chunkSize <= 20) {
      this.frontierDistance = Math.max(3, halfViewport + 1);
      this.memoryKeepRadius = 0;
      this.memoryChunkLimit = Math.min(this.cacheLimit, 8);
      this.solvePreviewMs = this.demoMode ? 18 : 70;
      this.revealDurationMs = this.demoMode ? 60 : 140;
    } else {
      this.frontierDistance = Math.max(2, halfViewport);
      this.memoryKeepRadius = 0;
      this.memoryChunkLimit = Math.min(this.cacheLimit, 4);
      this.solvePreviewMs = this.demoMode ? 18 : 60;
      this.revealDurationMs = this.demoMode ? 60 : 120;
    }
  }

  key(cx, cy) { return `${cx},${cy}`; }
  setLogger(fn) { this.logFn = fn; }
  log(msg) { if (this.logFn) this.logFn(msg); }
  setPlayerStart(x, y) { this.player = { x, y }; }
  solverMode() { return 'backtracking'; }

  chunkCoordsForTile(x, y) {
    return { cx: Math.floor(x / this.chunkSize), cy: Math.floor(y / this.chunkSize) };
  }

  viewportBounds() {
    const startX = this.player.x - Math.floor(this.viewportWidth / 2);
    const startY = this.player.y - Math.floor(this.viewportHeight / 2);
    return { startX, startY, endX: startX + this.viewportWidth - 1, endY: startY + this.viewportHeight - 1 };
  }

  visibleChunkRange() {
    const b = this.viewportBounds();
    return { min: this.chunkCoordsForTile(b.startX, b.startY), max: this.chunkCoordsForTile(b.endX, b.endY) };
  }

  renderWindow() {
    const viewport = this.viewportBounds();
    const pad = this.outerPaddingTiles;
    const width = this.viewportWidth + pad * 2;
    const height = this.viewportHeight + pad * 2;
    return { x: viewport.startX - pad, y: viewport.startY - pad, width, height, viewport, margin: { left: pad, right: pad, top: pad, bottom: pad } };
  }

  storageKey(cx, cy) { return `${this.storagePrefix}${cx},${cy}`; }

  getFromStorage(cx, cy) {
    if (this.disableStorageReads || typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(this.storageKey(cx, cy));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.size !== this.chunkSize) return null;
      if (!Array.isArray(parsed.grid) || parsed.grid.length !== this.chunkSize * this.chunkSize) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  saveToStorage(chunk) {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.storageKey(chunk.cx, chunk.cy), JSON.stringify({
      cx: chunk.cx,
      cy: chunk.cy,
      grid: chunk.grid,
      seed: chunk.seed,
      size: chunk.size,
    }));
  }

  touchMemory(chunk) {
    const k = this.key(chunk.cx, chunk.cy);
    if (this.memory.has(k)) this.memory.delete(k);
    this.memory.set(k, chunk);
    this.maxObservedMemory = Math.max(this.maxObservedMemory, this.memory.size);
  }

  getReadyChunk(cx, cy) {
    const k = this.key(cx, cy);
    const mem = this.memory.get(k);
    if (mem && ['ready', 'animating'].includes(mem.state) && mem.grid) return mem;
    const stored = this.getFromStorage(cx, cy);
    if (stored?.grid) {
      const chunk = { ...stored, state: 'ready', loadSource: 'storage', size: this.chunkSize, revealProgress: 1 };
      this.touchMemory(chunk);
      this.stats.recordChunk({ cx, cy, seed: chunk.seed, loadSource: 'storage', timeMs: 0, backtracks: 0, attempts: 0, internalOk: true, seamOk: true });
      this.log(`storage load ${cx},${cy}`);
      return chunk;
    }
    return null;
  }

  tileAtWorld(x, y) {
    const { cx, cy } = this.chunkCoordsForTile(x, y);
    const chunk = this.getReadyChunk(cx, cy);
    if (!chunk?.grid) return null;
    const lx = ((x % this.chunkSize) + this.chunkSize) % this.chunkSize;
    const ly = ((y % this.chunkSize) + this.chunkSize) % this.chunkSize;
    return chunk.grid[lx + ly * this.chunkSize];
  }

  isSideAdjacentChunk(sourceCx, sourceCy, minCx, maxCx, minCy, maxCy) {
    const leftAdj = sourceCx === minCx - 1 && sourceCy >= minCy && sourceCy <= maxCy;
    const rightAdj = sourceCx === maxCx + 1 && sourceCy >= minCy && sourceCy <= maxCy;
    const topAdj = sourceCy === minCy - 1 && sourceCx >= minCx && sourceCx <= maxCx;
    const bottomAdj = sourceCy === maxCy + 1 && sourceCx >= minCx && sourceCx <= maxCx;
    return leftAdj || rightAdj || topAdj || bottomAdj;
  }

  allowedTilesForCommittedNeighbor(direction, committedTile) {
    const allowed = new Set();
    for (let tile = 0; tile < this.rules.tileCount; tile++) {
      if (this.rules.propagator[direction][tile].includes(committedTile)) allowed.add(tile);
    }
    return allowed;
  }

  buildHaloSpec(minCx, maxCx, minCy, maxCy) {
    const halo = this.halo;
    const coreStartX = minCx * this.chunkSize;
    const coreStartY = minCy * this.chunkSize;
    const coreWidth = (maxCx - minCx + 1) * this.chunkSize;
    const coreHeight = (maxCy - minCy + 1) * this.chunkSize;
    const solveStartX = coreStartX - halo;
    const solveStartY = coreStartY - halo;
    const solveWidth = coreWidth + halo * 2;
    const solveHeight = coreHeight + halo * 2;

    const seeded = new Map();
    const counts = { sideHalo: 0, skippedDiagonal: 0, coreRestricted: 0 };

    for (let sy = 0; sy < solveHeight; sy++) {
      for (let sx = 0; sx < solveWidth; sx++) {
        const wx = solveStartX + sx;
        const wy = solveStartY + sy;
        const insideCore = wx >= coreStartX && wx < coreStartX + coreWidth && wy >= coreStartY && wy < coreStartY + coreHeight;
        if (!insideCore) {
          const { cx: sourceCx, cy: sourceCy } = this.chunkCoordsForTile(wx, wy);
          if (!this.isSideAdjacentChunk(sourceCx, sourceCy, minCx, maxCx, minCy, maxCy)) {
            counts.skippedDiagonal += 1;
            continue;
          }
          const tile = this.tileAtWorld(wx, wy);
          if (tile === null || tile === undefined) continue;
          seeded.set(sx + sy * solveWidth, new Set([tile]));
          counts.sideHalo += 1;
          continue;
        }

        let allowed = null;
        for (let d = 0; d < 4; d++) {
          const nx = wx + [1, 0, -1, 0][d];
          const ny = wy + [0, 1, 0, -1][d];
          const neighborInsideCore = nx >= coreStartX && nx < coreStartX + coreWidth && ny >= coreStartY && ny < coreStartY + coreHeight;
          if (neighborInsideCore) continue;
          const committedTile = this.tileAtWorld(nx, ny);
          if (committedTile === null || committedTile === undefined) continue;
          const directionAllowed = this.allowedTilesForCommittedNeighbor(d, committedTile);
          allowed = allowed ? new Set([...allowed].filter(tile => directionAllowed.has(tile))) : directionAllowed;
        }
        if (allowed && allowed.size > 0) {
          seeded.set(sx + sy * solveWidth, allowed);
          counts.coreRestricted += 1;
        }
      }
    }

    return { halo, coreStartX, coreStartY, coreWidth, coreHeight, solveStartX, solveStartY, solveWidth, solveHeight, seeded, counts };
  }

  makeCoreRegion(minCx, maxCx, minCy, maxCy, policy) {
    return { minCx, maxCx, minCy, maxCy, policy };
  }

  singleChunkRegions(region) {
    if (!region) return [];
    const playerChunk = this.chunkCoordsForTile(this.player.x, this.player.y);
    const chunks = [];
    for (let cy = region.minCy; cy <= region.maxCy; cy++) {
      for (let cx = region.minCx; cx <= region.maxCx; cx++) {
        chunks.push(this.makeCoreRegion(cx, cx, cy, cy, `${region.policy}-single`));
      }
    }
    chunks.sort((a, b) => {
      const acx = a.minCx;
      const acy = a.minCy;
      const bcx = b.minCx;
      const bcy = b.minCy;
      if (region.policy.includes('right') || region.policy.includes('left')) {
        const d = Math.abs(acy - playerChunk.cy) - Math.abs(bcy - playerChunk.cy);
        if (d !== 0) return d;
      } else if (region.policy.includes('up') || region.policy.includes('down')) {
        const d = Math.abs(acx - playerChunk.cx) - Math.abs(bcx - playerChunk.cx);
        if (d !== 0) return d;
      }
      const ad = Math.abs(acx - playerChunk.cx) + Math.abs(acy - playerChunk.cy);
      const bd = Math.abs(bcx - playerChunk.cx) + Math.abs(bcy - playerChunk.cy);
      if (ad !== bd) return ad - bd;
      if (acy !== bcy) return acy - bcy;
      return acx - bcx;
    });
    return chunks.filter(regionPart => this.regionMissing(regionPart));
  }

  enqueueChunkRegions(regions, toFront = false) {
    const ordered = toFront ? [...regions].reverse() : regions;
    for (const region of ordered) {
      if (!region || this.hasQueuedRegion(region) || !this.regionMissing(region)) continue;
      if (toFront) this.queue.unshift(region);
      else this.queue.push(region);
      const { minCx: cx, minCy: cy } = region;
      if (!this.memory.has(this.key(cx, cy))) {
        this.memory.set(this.key(cx, cy), { cx, cy, size: this.chunkSize, state: 'queued', region, progress: 0 });
      }
    }
    this.maxObservedQueue = Math.max(this.maxObservedQueue, this.queue.length);
  }

  solveRegionOnce(region, mode = 'backtracking') {
    const { minCx, maxCx, minCy, maxCy, policy } = region;
    const spec = this.buildHaloSpec(minCx, maxCx, minCy, maxCy);
    const { seeded, counts, solveWidth, solveHeight, halo } = spec;
    const seededCount = seeded.size;
    const seed = hashCoords(this.worldSeed, minCx, minCy, hashCoords(maxCx, maxCy, 911));
    this.log(`solve start region ${minCx}:${maxCx},${minCy}:${maxCy} mode=${mode} policy=${policy} halo=${halo} seeded=${seededCount} counts=${JSON.stringify(counts)}`);

    let solved = null;
    let metrics = null;
    const attempts = [{ mode, maxRestarts: this.fallbackMaxRestarts }];
    if (this.allowFallbackRestart && mode === 'backtracking') attempts.push({ mode: 'restart', maxRestarts: this.fallbackMaxRestarts });

    for (const attempt of attempts) {
      solved = new WFCSolver({
        width: solveWidth,
        height: solveHeight,
        rules: this.rules,
        seed,
        seededCells: seeded,
        mode: attempt.mode,
        maxRestarts: attempt.maxRestarts,
        maxTimeMs: this.solverMaxTimeMs,
      }).solve();
      metrics = solved.metrics;
      if (solved.grid) break;
      if (this.allowFallbackRestart && attempt.mode !== attempts[attempts.length - 1].mode) {
        this.log(`solve fallback ${attempt.mode}->restart region ${minCx}:${maxCx},${minCy}:${maxCy}`);
      }
    }

    if (!solved.grid) {
      this.log(`solve failed region ${minCx}:${maxCx},${minCy}:${maxCy} mode=${mode} policy=${policy} halo=${halo} seeded=${seededCount} counts=${JSON.stringify(counts)} metrics=${JSON.stringify(metrics)}`);
      return null;
    }

    const chunkCount = (maxCx - minCx + 1) * (maxCy - minCy + 1);
    const candidateChunks = [];
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        if (this.getReadyChunk(cx, cy)) continue;
        const grid = [];
        const ox = halo + (cx - minCx) * this.chunkSize;
        const oy = halo + (cy - minCy) * this.chunkSize;
        for (let y = 0; y < this.chunkSize; y++) {
          for (let x = 0; x < this.chunkSize; x++) {
            grid.push(solved.grid[(ox + x) + (oy + y) * solveWidth]);
          }
        }
        const chunk = {
          cx, cy, size: this.chunkSize,
          seed: hashCoords(this.worldSeed, cx, cy, 17),
          grid, state: 'ready', loadSource: 'generated', revealProgress: 1,
          metrics: { ...metrics, timeMs: metrics.timeMs / Math.max(1, chunkCount) },
        };
        candidateChunks.push(chunk);
      }
    }

    const candidateMap = new Map(candidateChunks.map(chunk => [this.key(chunk.cx, chunk.cy), chunk]));
    for (const chunk of candidateChunks) {
      const neighbors = {
        left: candidateMap.get(this.key(chunk.cx - 1, chunk.cy)) || this.getReadyChunk(chunk.cx - 1, chunk.cy),
        right: candidateMap.get(this.key(chunk.cx + 1, chunk.cy)) || this.getReadyChunk(chunk.cx + 1, chunk.cy),
        top: candidateMap.get(this.key(chunk.cx, chunk.cy - 1)) || this.getReadyChunk(chunk.cx, chunk.cy - 1),
        bottom: candidateMap.get(this.key(chunk.cx, chunk.cy + 1)) || this.getReadyChunk(chunk.cx, chunk.cy + 1),
      };
      const internal = validateChunkInternal(chunk.grid, this.chunkSize, this.rules);
      const seam = validateChunkAgainstNeighbors(chunk, neighbors, this.rules);
      chunk.internalValidation = internal;
      chunk.seamValidation = seam;
      if (!internal.ok || !seam.ok) {
        this.log(`solve rejected region ${minCx}:${maxCx},${minCy}:${maxCy} strategy=${metrics.strategy || metrics.mode} internal=${internal.ok} seam=${seam.ok}`);
        return null;
      }
    }

    for (const chunk of candidateChunks) {
      this.touchMemory(chunk);
      this.saveToStorage(chunk);
      this.stats.recordChunk({
        cx: chunk.cx,
        cy: chunk.cy,
        seed: chunk.seed,
        loadSource: 'generated',
        timeMs: chunk.metrics.timeMs,
        backtracks: metrics.backtracks,
        attempts: metrics.attempts,
        internalOk: chunk.internalValidation.ok,
        seamOk: chunk.seamValidation.ok,
      });
    }
    this.log(`solve ok region ${minCx}:${maxCx},${minCy}:${maxCy} strategy=${metrics.strategy || metrics.mode} halo=${halo} time=${metrics.timeMs.toFixed(2)}ms attempts=${metrics.attempts} backtracks=${metrics.backtracks}`);
    return { chunks: candidateChunks, metrics, spec };
  }

  fallbackRegions(region) {
    const out = [region];
    const { minCx, maxCx, minCy, maxCy, policy } = region;
    const isSingle = minCx === maxCx && minCy === maxCy;
    if (!isSingle) return out;
    const cx = minCx;
    const cy = minCy;
    if (this.activeDirection === 'right') out.push(this.makeCoreRegion(cx, cx + 1, cy, cy, `${policy}-expand-right`));
    if (this.activeDirection === 'left') out.push(this.makeCoreRegion(cx - 1, cx, cy, cy, `${policy}-expand-left`));
    if (this.activeDirection === 'down') out.push(this.makeCoreRegion(cx, cx, cy, cy + 1, `${policy}-expand-down`));
    if (this.activeDirection === 'up') out.push(this.makeCoreRegion(cx, cx, cy - 1, cy, `${policy}-expand-up`));
    out.push(this.makeCoreRegion(cx, cx + 1, cy, cy, `${policy}-expand-h`));
    out.push(this.makeCoreRegion(cx, cx, cy, cy + 1, `${policy}-expand-v`));
    out.push(this.makeCoreRegion(cx - 1, cx + 1, cy, cy, `${policy}-expand-triplet-h`));
    out.push(this.makeCoreRegion(cx, cx, cy - 1, cy + 1, `${policy}-expand-triplet-v`));
    out.push(this.makeCoreRegion(cx - 1, cx, cy - 1, cy, `${policy}-expand-block-ul`));
    out.push(this.makeCoreRegion(cx, cx + 1, cy - 1, cy, `${policy}-expand-block-ur`));
    out.push(this.makeCoreRegion(cx - 1, cx, cy, cy + 1, `${policy}-expand-block-dl`));
    out.push(this.makeCoreRegion(cx, cx + 1, cy, cy + 1, `${policy}-expand-block-dr`));
    return out.filter((r, i, arr) => arr.findIndex(a => a.minCx === r.minCx && a.maxCx === r.maxCx && a.minCy === r.minCy && a.maxCy === r.maxCy) === i)
      .map(r => ({ ...r, minCx: Math.min(r.minCx, r.maxCx), maxCx: Math.max(r.minCx, r.maxCx), minCy: Math.min(r.minCy, r.maxCy), maxCy: Math.max(r.minCy, r.maxCy) }));
  }

  solveRegion(region, mode = this.solverMode()) {
    for (const candidate of this.fallbackRegions(region)) {
      const solved = this.solveRegionOnce(candidate, mode);
      if (solved) return solved;
    }
    return null;
  }

  generateAlignedViewportBlock() {
    const range = this.visibleChunkRange();
    const region = this.makeCoreRegion(range.min.cx, range.max.cx, range.min.cy, range.max.cy, 'initial-visible-block');
    for (const single of this.singleChunkRegions(region)) this.solveRegion(single, this.solverMode());
  }

  setDirection(dx, dy) {
    if (dx === 1) this.activeDirection = 'right';
    else if (dx === -1) this.activeDirection = 'left';
    else if (dy === 1) this.activeDirection = 'down';
    else if (dy === -1) this.activeDirection = 'up';
  }

  visibleMissingRegion() {
    const range = this.visibleChunkRange();
    let minCx = Infinity, maxCx = -Infinity, minCy = Infinity, maxCy = -Infinity, missing = false;
    for (let cy = range.min.cy; cy <= range.max.cy; cy++) {
      for (let cx = range.min.cx; cx <= range.max.cx; cx++) {
        if (!this.getReadyChunk(cx, cy)) {
          missing = true;
          minCx = Math.min(minCx, cx);
          maxCx = Math.max(maxCx, cx);
          minCy = Math.min(minCy, cy);
          maxCy = Math.max(maxCy, cy);
        }
      }
    }
    if (!missing) return null;
    return this.makeCoreRegion(minCx, maxCx, minCy, maxCy, 'visible-block');
  }

  frontierRegion() {
    if (!this.activeDirection) return null;
    const range = this.visibleChunkRange();
    if (this.activeDirection === 'right') return this.makeCoreRegion(range.max.cx + 1, range.max.cx + 1, range.min.cy, range.max.cy, 'right-band');
    if (this.activeDirection === 'left') return this.makeCoreRegion(range.min.cx - 1, range.min.cx - 1, range.min.cy, range.max.cy, 'left-band');
    if (this.activeDirection === 'down') return this.makeCoreRegion(range.min.cx, range.max.cx, range.max.cy + 1, range.max.cy + 1, 'down-band');
    return this.makeCoreRegion(range.min.cx, range.max.cx, range.min.cy - 1, range.min.cy - 1, 'up-band');
  }

  regionMissing(region) {
    for (let cy = region.minCy; cy <= region.maxCy; cy++) {
      for (let cx = region.minCx; cx <= region.maxCx; cx++) {
        if (!this.getReadyChunk(cx, cy)) return true;
      }
    }
    return false;
  }

  hasQueuedRegion(region) {
    if (!region) return false;
    const same = r => r.minCx === region.minCx && r.maxCx === region.maxCx && r.minCy === region.minCy && r.maxCy === region.maxCy;
    return this.queue.some(same) || (!!this.activeJob?.region && same(this.activeJob.region));
  }

  frontierKeySet() {
    const set = new Set();
    const addRegion = region => {
      if (!region) return;
      for (let cy = region.minCy; cy <= region.maxCy; cy++) {
        for (let cx = region.minCx; cx <= region.maxCx; cx++) set.add(this.key(cx, cy));
      }
    };
    this.queue.forEach(addRegion);
    addRegion(this.activeJob?.region);
    return set;
  }

  distanceToBoundary() {
    const localX = ((this.player.x % this.chunkSize) + this.chunkSize) % this.chunkSize;
    const localY = ((this.player.y % this.chunkSize) + this.chunkSize) % this.chunkSize;
    if (this.activeDirection === 'right') return (this.chunkSize - 1) - localX;
    if (this.activeDirection === 'left') return localX;
    if (this.activeDirection === 'down') return (this.chunkSize - 1) - localY;
    if (this.activeDirection === 'up') return localY;
    return Infinity;
  }

  shouldQueueFrontier() {
    if (!this.activeDirection) return false;
    return this.distanceToBoundary() <= this.frontierDistance;
  }

  ensureVisibleQueued() {
    const region = this.visibleMissingRegion();
    if (!region) return;
    const singles = this.singleChunkRegions(region);
    if (!singles.length) return;
    this.enqueueChunkRegions(singles, true);
    this.log(`queued visible chunks ${singles.map(r => `${r.minCx},${r.minCy}`).join(' | ')}`);
  }

  ensureFrontierQueued() {
    const region = this.frontierRegion();
    if (!region || !this.shouldQueueFrontier()) return;
    const singles = this.singleChunkRegions(region);
    if (!singles.length) return;
    this.enqueueChunkRegions(singles, false);
    this.log(`queued frontier chunks ${singles.map(r => `${r.minCx},${r.minCy}`).join(' | ')} trigger<=${this.frontierDistance}`);
  }

  move(dx, dy) {
    const before = { ...this.player };
    this.player.x += dx;
    this.player.y += dy;
    this.setDirection(dx, dy);
    this.log(`move ${dx},${dy} from ${before.x},${before.y} to ${this.player.x},${this.player.y} dir=${this.activeDirection}`);
    this.ensureVisibleQueued();
    this.ensureFrontierQueued();
  }

  buildRegionPreview(region) {
    const spec = this.buildHaloSpec(region.minCx, region.maxCx, region.minCy, region.maxCy);
    const preview = new Array(spec.solveWidth * spec.solveHeight).fill(null);
    for (const [index, set] of spec.seeded.entries()) {
      if (set.size === 1) preview[index] = [...set][0];
      else preview[index] = set;
    }
    return { preview, width: spec.solveWidth, height: spec.solveHeight, halo: spec.halo };
  }

  startNextJob(now) {
    if (this.activeJob || this.queue.length === 0) return;
    const region = this.queue.shift();
    const { preview, width, height, halo } = this.buildRegionPreview(region);
    this.activeJob = { region, phase: 'preview', phaseStart: now, preview, width, height, halo };
    this.log(`job preview region ${region.minCx}:${region.maxCx},${region.minCy}:${region.maxCy}`);
    for (let cy = region.minCy; cy <= region.maxCy; cy++) {
      for (let cx = region.minCx; cx <= region.maxCx; cx++) {
        this.memory.set(this.key(cx, cy), { cx, cy, size: this.chunkSize, state: 'solving', region, preview, previewWidth: width, previewHeight: height, previewHalo: halo, progress: 0 });
      }
    }
    this.maxObservedMemory = Math.max(this.maxObservedMemory, this.memory.size);
  }

  desiredRetainKeys() {
    const retain = new Set();
    const range = this.visibleChunkRange();
    for (let cy = range.min.cy; cy <= range.max.cy; cy++) {
      for (let cx = range.min.cx; cx <= range.max.cx; cx++) retain.add(this.key(cx, cy));
    }
    if (this.memoryKeepRadius > 0) {
      for (let cy = range.min.cy - this.memoryKeepRadius; cy <= range.max.cy + this.memoryKeepRadius; cy++) {
        for (let cx = range.min.cx - this.memoryKeepRadius; cx <= range.max.cx + this.memoryKeepRadius; cx++) retain.add(this.key(cx, cy));
      }
    }
    const frontier = this.frontierRegion();
    if (frontier && this.shouldQueueFrontier()) {
      for (let cy = frontier.minCy; cy <= frontier.maxCy; cy++) {
        for (let cx = frontier.minCx; cx <= frontier.maxCx; cx++) retain.add(this.key(cx, cy));
      }
    }
    if (this.activeJob?.region) {
      const region = this.activeJob.region;
      for (let cy = region.minCy; cy <= region.maxCy; cy++) {
        for (let cx = region.minCx; cx <= region.maxCx; cx++) retain.add(this.key(cx, cy));
      }
    }
    return retain;
  }

  pruneMemory() {
    const retain = this.desiredRetainKeys();
    for (const [key, chunk] of [...this.memory.entries()]) {
      if (chunk.state === 'solving' || chunk.state === 'queued') continue;
      if (!retain.has(key) && (chunk.state === 'ready' || chunk.state === 'animating')) {
        this.memory.delete(key);
        this.stats.recordMemoryEviction();
        this.log(`evicted chunk ${key}`);
      }
    }
    if (this.memory.size <= this.memoryChunkLimit) return;
    const playerChunk = this.chunkCoordsForTile(this.player.x, this.player.y);
    const removable = [...this.memory.entries()].filter(([key, chunk]) => !retain.has(key) && chunk.state === 'ready');
    removable.sort((a, b) => {
      const da = Math.abs(a[1].cx - playerChunk.cx) + Math.abs(a[1].cy - playerChunk.cy);
      const db = Math.abs(b[1].cx - playerChunk.cx) + Math.abs(b[1].cy - playerChunk.cy);
      return db - da;
    });
    for (const [key] of removable) {
      if (this.memory.size <= this.memoryChunkLimit) break;
      this.memory.delete(key);
      this.stats.recordMemoryEviction();
      this.log(`evicted chunk ${key}`);
    }
  }

  tick(now) {
    this.ensureVisibleQueued();
    this.startNextJob(now);
    if (!this.activeJob) {
      this.pruneMemory();
      return;
    }
    const { region } = this.activeJob;
    if (this.activeJob.phase === 'preview') {
      const elapsed = now - this.activeJob.phaseStart;
      const progress = Math.min(1, elapsed / this.solvePreviewMs);
      for (let cy = region.minCy; cy <= region.maxCy; cy++) {
        for (let cx = region.minCx; cx <= region.maxCx; cx++) {
          const holder = this.memory.get(this.key(cx, cy));
          if (holder) holder.progress = progress;
        }
      }
      if (elapsed < this.solvePreviewMs) {
        this.pruneMemory();
        return;
      }
      const solved = this.solveRegion(region, this.solverMode());
      if (!solved) {
        this.log(`job failed region ${region.minCx}:${region.maxCx},${region.minCy}:${region.maxCy}`);
        for (let cy = region.minCy; cy <= region.maxCy; cy++) {
          for (let cx = region.minCx; cx <= region.maxCx; cx++) this.memory.delete(this.key(cx, cy));
        }
        this.activeJob = null;
        this.pruneMemory();
        return;
      }
      for (const chunk of solved.chunks) {
        chunk.state = 'animating';
        chunk.revealProgress = 0;
        this.memory.set(this.key(chunk.cx, chunk.cy), chunk);
      }
      this.activeJob = { region, phase: 'animating', phaseStart: now, chunks: solved.chunks };
      this.log(`job animating region ${region.minCx}:${region.maxCx},${region.minCy}:${region.maxCy}`);
      this.pruneMemory();
      return;
    }

    const elapsed = now - this.activeJob.phaseStart;
    const progress = Math.min(1, elapsed / this.revealDurationMs);
    for (const chunk of this.activeJob.chunks) {
      chunk.revealProgress = progress;
      this.memory.set(this.key(chunk.cx, chunk.cy), chunk);
    }
    if (progress >= 1) {
      for (const chunk of this.activeJob.chunks) {
        chunk.state = 'ready';
        chunk.revealProgress = 1;
        this.touchMemory(chunk);
      }
      this.log(`job ready region ${region.minCx}:${region.maxCx},${region.minCy}:${region.maxCy}`);
      this.activeJob = null;
      this.ensureFrontierQueued();
    }
    this.pruneMemory();
  }

  runRevisitTest() {
    const storageLoadsBefore = this.stats.generated.filter(r => r.loadSource === 'storage').length;
    const originalPlayer = { ...this.player };
    const originalDirection = this.activeDirection;
    const points = [
      { x: this.player.x, y: this.player.y },
      { x: this.player.x + 5, y: this.player.y + 5 },
      { x: this.player.x - 4, y: this.player.y + 2 },
    ];
    const before = points.map(p => this.tileAt(p.x, p.y));
    const trackedKeys = new Set(points.map(p => {
      const { cx, cy } = this.chunkCoordsForTile(p.x, p.y);
      return this.key(cx, cy);
    }));

    this.player = { x: originalPlayer.x + this.chunkSize * 20, y: originalPlayer.y + this.chunkSize * 20 };
    this.activeDirection = 'right';
    for (let i = 0; i < this.memoryChunkLimit + 10; i++) {
      const cx = 50 + i;
      this.solveRegion(this.makeCoreRegion(cx, cx, 50, 50, 'revisit-evict'), this.solverMode());
      this.pruneMemory();
    }

    const evicted = [...trackedKeys].every(key => !this.memory.has(key));
    this.player = originalPlayer;
    this.activeDirection = originalDirection;
    const after = points.map(p => this.tileAt(p.x, p.y));
    const ok = before.every((v, i) => v === after[i]);
    this.stats.setRevisitConsistency(ok);
    const storageLoadsAfter = this.stats.generated.filter(r => r.loadSource === 'storage').length;
    return { ok, evicted, storageLoadsAdded: storageLoadsAfter - storageLoadsBefore, before, after };
  }

  tileAt(x, y) {
    const { cx, cy } = this.chunkCoordsForTile(x, y);
    let chunk = this.getReadyChunk(cx, cy);
    if (!chunk) {
      const solved = this.solveRegion(this.makeCoreRegion(cx, cx, cy, cy, 'tileAt'), this.solverMode());
      chunk = solved?.chunks?.find(c => c.cx === cx && c.cy === cy) || null;
    }
    if (!chunk?.grid) {
      this.log(`tileAt unresolved ${x},${y} chunk=${cx},${cy}`);
      return null;
    }
    const lx = ((x % this.chunkSize) + this.chunkSize) % this.chunkSize;
    const ly = ((y % this.chunkSize) + this.chunkSize) % this.chunkSize;
    return chunk.grid[lx + ly * this.chunkSize];
  }
}
