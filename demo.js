import { loadSummerRules } from './rules.js';
import { WFCSolver } from './solver.js';
import { hashCoords } from './rng.js';
import { validateChunkAgainstNeighbors, validateChunkInternal } from './validators.js';
import {
  DEMO_PRESET,
  PLAYER_START_MULTIPLIER,
  TILE_SIZE,
  MAX_DEMO_LOG_ENTRIES,
  CHUNK_SOLVE_MS,
  RESTART_SOLVE_MS,
  DEEP_SOLVE_MS,
  DEFAULT_OUTER_PADDING_TILES,
  DX,
  DY,
} from './CONFIG.js';
import { getTileColor, checksumGrid, getAllowedTilesForCommittedNeighbor } from './utils.js';
import {
  chunkKey,
  chunkCoordsForTile as coordsForTile,
  buildStorageKey,
  loadChunkFromStorage as loadFromStorage,
  saveChunkToStorage as saveToStorage,
  touchMemoryLRU,
  tileAtCoords,
  calculateVisibleChunkRange,
  chunkDistance,
  directionFromDelta,
  localCoordsInChunk,
  isInRegion,
} from './worldCommon.js';

// Use DEMO_PRESET from CONFIG as PRESET for backward compatibility
const PRESET = DEMO_PRESET;
const DEMO_STORAGE_VERSION = 'v2';

function fallbackColor(name) {
  return getTileColor(name);
}

function drawTile(ctx, tile, x, y, size) {
  if (tile?.image) ctx.drawImage(tile.image, x, y, size, size);
  else {
    ctx.fillStyle = fallbackColor(tile?.name || 'grass');
    ctx.fillRect(x, y, size, size);
  }
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
      x: Math.floor(this.options.chunkSize * PLAYER_START_MULTIPLIER),
      y: Math.floor(this.options.chunkSize * PLAYER_START_MULTIPLIER),
    };
    this.activeDirection = 'right';
    this.storagePrefix = `streaming-wfc-demo:${DEMO_STORAGE_VERSION}:${this.options.seed}:chunk${this.options.chunkSize}:`;
    this.stats = {
      generated: 0,
      storageLoads: 0,
      evictions: 0,
      seamViolations: 0,
      internalViolations: 0,
      seamsRepaired: 0,
      seamsRepairedOnLoad: 0,
      failedGenerations: 0,
      peakMemory: 0,
      peakQueue: 0,
      totalSolveTimeMs: 0,
      maxSolveTimeMs: 0,
      generatedChunkRecords: [],
      reloadChecks: { matches: 0, mismatches: 0 },
      fallbackStats: {
        seamOnlySuccess: 0,
        minimalTileSuccess: 0,
        fullChunkResortUsed: 0,
        fallbackFailures: 0,
      },
      movementSteps: 0,
      uniqueVisitedChunks: new Set(),
    };
    this.chunkChecksums = new Map();
    this.eventHistory = [];
    this.status = 'Ready';
    this.grassTile = this.rules.tiles.findIndex(tile => tile.name === 'grass');
  }

  key(cx, cy) {
    return chunkKey(cx, cy);
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
    return coordsForTile(this.options.chunkSize, x, y);
  }

  storageKey(cx, cy) {
    return buildStorageKey(this.storagePrefix, cx, cy);
  }

  getStoredChunkRaw(cx, cy) {
    return loadFromStorage(
      this.storageKey(cx, cy),
      (parsed) => parsed && Array.isArray(parsed.grid) && parsed.grid.length === this.options.chunkSize * this.options.chunkSize
    );
  }

  saveChunk(chunk) {
    saveToStorage(this.storageKey(chunk.cx, chunk.cy), chunk);
  }

  getMemoryChunk(cx, cy) {
    return this.memory.get(this.key(cx, cy)) || null;
  }

  touchChunk(chunk) {
    const key = this.key(chunk.cx, chunk.cy);
    const size = touchMemoryLRU(this.memory, key, chunk);
    this.stats.peakMemory = Math.max(this.stats.peakMemory, size);
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

    const neighbors = {
      left: this.getCommittedChunk(cx - 1, cy),
      right: this.getCommittedChunk(cx + 1, cy),
      top: this.getCommittedChunk(cx, cy - 1),
      bottom: this.getCommittedChunk(cx, cy + 1),
    };
    const internal = validateChunkInternal(chunk.grid, chunk.size, this.rules);
    const seam = validateChunkAgainstNeighbors(chunk, neighbors, this.rules);
    if (!internal.ok || !seam.ok) {
      this.log(`storage rejected ${cx},${cy} internal=${internal.ok} seam=${seam.ok}`);
      return null;
    }

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
          const directionAllowed = getAllowedTilesForCommittedNeighbor(this.rules, d, committed);
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

  runSolverSequence(seed, seededCells, width, height, configs) {
    const aggregate = {
      mode: 'unknown',
      attempts: 0,
      backtracks: 0,
      contradictions: 0,
      observations: 0,
      timedOut: false,
      timeMs: 0,
      contradictionCell: null,
    };
    let lastFailure = null;

    for (let i = 0; i < configs.length; i++) {
      const config = configs[i];
      const solverSeed = hashCoords(seed, i, config.seedSalt ?? 131);
      const result = new WFCSolver({
        width,
        height,
        rules: this.rules,
        seed: solverSeed,
        seededCells,
        mode: config.mode,
        maxRestarts: config.maxRestarts,
        maxTimeMs: config.maxTimeMs,
      }).solve();
      const metrics = result.metrics || {};
      aggregate.attempts += metrics.attempts ?? 0;
      aggregate.backtracks += metrics.backtracks ?? 0;
      aggregate.contradictions += metrics.contradictions ?? 0;
      aggregate.observations += metrics.observations ?? 0;
      aggregate.timeMs += metrics.timeMs ?? 0;
      if (metrics.timedOut) aggregate.timedOut = true;
      if (metrics.contradictionCell) aggregate.contradictionCell = metrics.contradictionCell;

      if (result.grid) {
        aggregate.mode = config.label || metrics.mode || config.mode;
        return { solved: result, metrics: aggregate, lastFailure };
      }

      lastFailure = result;
      if (metrics.contradictionCell) lastFailure.metrics.contradictionCell = metrics.contradictionCell;
    }

    return { solved: null, metrics: aggregate, lastFailure };
  }

  boundarySolveConfigs(width, height) {
    const singleChunkArea = this.options.chunkSize * this.options.chunkSize;
    const areaScale = Math.max(1, (width * height) / singleChunkArea);
    return [
      {
        mode: 'backtracking',
        maxTimeMs: Math.min(Math.round(this.options.chunkSolveMs * areaScale), this.options.chunkSolveMs * 2),
        label: 'boundary-backtracking',
        seedSalt: 211,
      },
      {
        mode: 'restart',
        maxRestarts: 24,
        maxTimeMs: Math.min(Math.round(this.options.restartSolveMs * areaScale), this.options.restartSolveMs * 2),
        label: 'boundary-restart',
        seedSalt: 223,
      },
      {
        mode: 'backtracking',
        maxTimeMs: Math.min(Math.round(this.options.deepSolveMs * areaScale), this.options.deepSolveMs * 2),
        label: 'boundary-deep',
        seedSalt: 227,
      },
    ];
  }

  interiorBacktrackingConfigs(width, height) {
    const singleChunkArea = this.options.chunkSize * this.options.chunkSize;
    const areaScale = Math.max(1, (width * height) / singleChunkArea);
    return [
      {
        mode: 'backtracking',
        maxTimeMs: Math.min(Math.round(this.options.chunkSolveMs * areaScale), this.options.chunkSolveMs * 3),
        label: 'interior-backtracking',
        seedSalt: 307,
      },
      {
        mode: 'backtracking',
        maxTimeMs: Math.min(Math.round(this.options.deepSolveMs * areaScale), this.options.deepSolveMs * 3),
        label: 'interior-deep-backtracking',
        seedSalt: 331,
      },
    ];
  }

  buildBoundarySeededCells(region) {
    const seeded = new Map();
    for (const [index, allowedValues] of region.seeded.entries()) {
      const x = index % region.width;
      const y = Math.floor(index / region.width);
      const allowed = allowedValues instanceof Set ? allowedValues : new Set(allowedValues);
      const isBoundary = x === 0 || y === 0 || x === region.width - 1 || y === region.height - 1;
      const isFixed = allowed.size === 1;
      if (isBoundary || isFixed) seeded.set(index, new Set(allowed));
    }
    return seeded;
  }

  buildInteriorSeededCellsFromBoundary(region, boundaryGrid) {
    const seeded = new Map();
    for (const [index, allowedValues] of region.seeded.entries()) {
      const allowed = allowedValues instanceof Set ? allowedValues : new Set(allowedValues);
      seeded.set(index, new Set(allowed));
    }
    for (let y = 0; y < region.height; y++) {
      for (let x = 0; x < region.width; x++) {
        const isBoundary = x === 0 || y === 0 || x === region.width - 1 || y === region.height - 1;
        if (!isBoundary) continue;
        const index = x + y * region.width;
        seeded.set(index, new Set([boundaryGrid[index]]));
      }
    }
    return seeded;
  }

  isBoundaryAdjacentFailure(region, failureResult) {
    const failure = failureResult?.metrics?.contradictionCell;
    if (!failure) return false;
    const x = failure.x;
    const y = failure.y;
    if (x < 0 || y < 0 || x >= region.width || y >= region.height) return false;
    // Treat boundary and one-step-inside cells as boundary-adjacent failures.
    return x <= 1 || y <= 1 || x >= region.width - 2 || y >= region.height - 2;
  }

  solveRegionWithConditionalBoundaryReseed(region, seed, label) {
    const maxBoundaryReseeds = 3;
    const boundarySeeded = this.buildBoundarySeededCells(region);
    let reseedCount = 0;

    while (reseedCount <= maxBoundaryReseeds) {
      const boundarySeed = hashCoords(seed, reseedCount, 401);
      const boundaryPass = this.runSolverSequence(
        boundarySeed,
        boundarySeeded,
        region.width,
        region.height,
        this.boundarySolveConfigs(region.width, region.height)
      );

      if (!boundaryPass.solved?.grid) {
        reseedCount += 1;
        continue;
      }

      const interiorSeeded = this.buildInteriorSeededCellsFromBoundary(region, boundaryPass.solved.grid);
      const interiorSeed = hashCoords(seed, reseedCount, 509);
      const interiorPass = this.runSolverSequence(
        interiorSeed,
        interiorSeeded,
        region.width,
        region.height,
        this.interiorBacktrackingConfigs(region.width, region.height)
      );

      if (interiorPass.solved?.grid) {
        return {
          solved: interiorPass.solved,
          metrics: {
            mode: 'boundary-internal-backtracking',
            attempts: (boundaryPass.metrics.attempts || 0) + (interiorPass.metrics.attempts || 0),
            backtracks: (boundaryPass.metrics.backtracks || 0) + (interiorPass.metrics.backtracks || 0),
            contradictions: (boundaryPass.metrics.contradictions || 0) + (interiorPass.metrics.contradictions || 0),
            observations: (boundaryPass.metrics.observations || 0) + (interiorPass.metrics.observations || 0),
            timedOut: !!(boundaryPass.metrics.timedOut || interiorPass.metrics.timedOut),
            boundaryReseeds: reseedCount,
          },
        };
      }

      if (this.isBoundaryAdjacentFailure(region, interiorPass.lastFailure)) {
        reseedCount += 1;
        this.log(`boundary reseed ${label} ${region.startX},${region.startY} attempt=${reseedCount}`);
        continue;
      }

      // Deep interior failure: keep boundary fixed and rely on normal interior backtracking only.
      return null;
    }

    return null;
  }

  fallbackRegionCandidates(cx, cy) {
    // Start with the single chunk as the primary candidate
    const candidates = [{ minCx: cx, maxCx: cx, minCy: cy, maxCy: cy, label: 'single' }];

    // Add expanded region candidates (matching WorldManager strategy)
    // These provide fallback regions for when a single chunk fails to solve
    if (this.activeDirection === 'right') candidates.push({ minCx: cx, maxCx: cx + 1, minCy: cy, maxCy: cy, label: 'expand-right' });
    if (this.activeDirection === 'left') candidates.push({ minCx: cx - 1, maxCx: cx, minCy: cy, maxCy: cy, label: 'expand-left' });
    if (this.activeDirection === 'down') candidates.push({ minCx: cx, maxCx: cx, minCy: cy, maxCy: cy + 1, label: 'expand-down' });
    if (this.activeDirection === 'up') candidates.push({ minCx: cx, maxCx: cx, minCy: cy - 1, maxCy: cy, label: 'expand-up' });

    // Add directional and neutral expansions
    candidates.push({ minCx: cx, maxCx: cx + 1, minCy: cy, maxCy: cy, label: 'expand-h' });
    candidates.push({ minCx: cx, maxCx: cx, minCy: cy, maxCy: cy + 1, label: 'expand-v' });
    candidates.push({ minCx: cx - 1, maxCx: cx + 1, minCy: cy, maxCy: cy, label: 'expand-triplet-h' });
    candidates.push({ minCx: cx, maxCx: cx, minCy: cy - 1, maxCy: cy + 1, label: 'expand-triplet-v' });

    // Add 2x2 block expansions
    candidates.push({ minCx: cx - 1, maxCx: cx, minCy: cy - 1, maxCy: cy, label: 'expand-block-ul' });
    candidates.push({ minCx: cx, maxCx: cx + 1, minCy: cy - 1, maxCy: cy, label: 'expand-block-ur' });
    candidates.push({ minCx: cx - 1, maxCx: cx, minCy: cy, maxCy: cy + 1, label: 'expand-block-dl' });
    candidates.push({ minCx: cx, maxCx: cx + 1, minCy: cy, maxCy: cy + 1, label: 'expand-block-dr' });

    // Normalize and deduplicate regions
    const normalized = candidates.map(r => ({
      ...r,
      minCx: Math.min(r.minCx, r.maxCx),
      maxCx: Math.max(r.minCx, r.maxCx),
      minCy: Math.min(r.minCy, r.maxCy),
      maxCy: Math.max(r.minCy, r.maxCy),
    }));

    return normalized.filter((r, i, arr) => 
      arr.findIndex(a => a.minCx === r.minCx && a.maxCx === r.maxCx && a.minCy === r.minCy && a.maxCy === r.maxCy) === i
    );
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

    const tieSeed = hashCoords(this.options.seed, worldX, worldY, 131);
    options.sort((a, b) => {
      const dw = this.rules.weights[b] - this.rules.weights[a];
      if (dw !== 0) return dw;
      // Deterministic tie-break to avoid a fixed tile-id bias.
      return ((a ^ tieSeed) - (b ^ tieSeed));
    });
    return options;
  }

  generateStructuredFallbackChunk(cx, cy) {
    const size = this.options.chunkSize;
    const grid = new Array(size * size).fill(-1);
    const start = performance.now();
    const deadline = start + Math.max(200, this.options.deepSolveMs);
    let backtracks = 0;
    let bestFilled = 0;
    let bestGrid = grid.slice();

    const updateBest = (filledCount) => {
      if (filledCount > bestFilled) {
        bestFilled = filledCount;
        bestGrid = grid.slice();
      }
    };

    const search = (filledCount = 0) => {
      if (performance.now() > deadline) return false;
      updateBest(filledCount);

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
        if (search(filledCount + 1)) return true;
        grid[bestIndex] = -1;
        backtracks += 1;
      }
      return false;
    };

    if (search(0)) {
      const elapsed = performance.now() - start;
      return {
        cx, cy, size,
        seed: hashCoords(this.options.seed, cx, cy, 17),
        grid,
        state: 'ready',
        loadSource: 'generated',
        flashUntil: performance.now() + 650,
        flashType: 'generated',
        checksum: checksumGrid(grid),
        metrics: { mode: 'structured-fallback', attempts: 1, backtracks, contradictions: backtracks },
        elapsedMs: elapsed,
      };
    }

    // Graceful fallback: only patch unresolved cells after best partial backtracking state.
    if (bestFilled > 0) {
      const partial = bestGrid.slice();
      const patchResult = this.completeFallbackGrid(cx, cy, partial, deadline);
      if (patchResult) {
        const elapsed = performance.now() - start;
        return {
          cx, cy, size,
          seed: hashCoords(this.options.seed, cx, cy, 17),
          grid: patchResult.grid,
          state: 'ready',
          loadSource: 'generated',
          flashUntil: performance.now() + 650,
          flashType: 'generated',
          checksum: checksumGrid(patchResult.grid),
          metrics: {
            mode: 'minimal-tile-fallback',
            attempts: 1,
            backtracks,
            contradictions: backtracks,
            resolvedBySearch: bestFilled,
            patchedTiles: patchResult.patchedTiles,
          },
          elapsedMs: elapsed,
        };
      }
    }

    this.log(`structured fallback failed ${cx},${cy}`);
    return null;
  }

  completeFallbackGrid(cx, cy, grid, deadline) {
    const size = this.options.chunkSize;
    let patchedTiles = 0;

    while (true) {
      if (performance.now() > deadline) return null;

      let bestIndex = -1;
      let bestOptions = null;
      for (let index = 0; index < grid.length; index++) {
        if (grid[index] !== -1) continue;
        const x = index % size;
        const y = Math.floor(index / size);
        const options = this.fallbackCellOptions(cx, cy, x, y, grid);
        if (options.length === 0) return null;
        if (!bestOptions || options.length < bestOptions.length) {
          bestIndex = index;
          bestOptions = options;
          if (options.length === 1) break;
        }
      }

      if (bestIndex === -1) return { grid, patchedTiles };

      grid[bestIndex] = bestOptions[0];
      patchedTiles += 1;
    }
  }

  generateFullChunkResortChunk(cx, cy) {
    const size = this.options.chunkSize;
    const neighbors = {
      left: this.getCommittedChunk(cx - 1, cy),
      right: this.getCommittedChunk(cx + 1, cy),
      top: this.getCommittedChunk(cx, cy - 1),
      bottom: this.getCommittedChunk(cx, cy + 1),
    };

    const candidateTiles = [];
    const pushUnique = (t) => {
      if (Number.isInteger(t) && t >= 0 && t < this.rules.tileCount && !candidateTiles.includes(t)) candidateTiles.push(t);
    };

    pushUnique(12);
    pushUnique(25);
    pushUnique(this.grassTile);
    pushUnique(0);

    for (const fallbackTile of candidateTiles) {
      const grid = new Array(size * size).fill(fallbackTile);
      const chunk = {
        cx,
        cy,
        size,
        seed: hashCoords(this.options.seed, cx, cy, 17),
        grid,
        state: 'ready',
        loadSource: 'generated',
        flashUntil: performance.now() + 650,
        flashType: 'generated-fallback',
        checksum: checksumGrid(grid),
      };

      const internal = validateChunkInternal(chunk.grid, chunk.size, this.rules);
      const seam = validateChunkAgainstNeighbors(chunk, neighbors, this.rules);
      if (internal.ok && seam.ok) {
        return {
          ...chunk,
          metrics: {
            mode: 'full-chunk-resort',
            attempts: 1,
            backtracks: 0,
            contradictions: 0,
            fallbackTile,
          },
          elapsedMs: 0,
        };
      }
    }

    return null;
  }

  generateDemoEmergencyChunk(cx, cy) {
    const size = this.options.chunkSize;
    const grid = new Array(size * size).fill(-1);
    const start = performance.now();

    for (let index = 0; index < grid.length; index++) {
      const x = index % size;
      const y = Math.floor(index / size);
      const options = this.fallbackCellOptions(cx, cy, x, y, grid);
      if (options.length > 0) {
        grid[index] = options[0];
      } else {
        // Demo-only keepalive: prefer grass/default tile when local constraints are unsatisfiable.
        grid[index] = this.grassTile >= 0 ? this.grassTile : 0;
      }
    }

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
      flashType: 'generated-fallback',
      checksum: checksumGrid(grid),
      metrics: {
        mode: 'demo-emergency-fill',
        attempts: 1,
        backtracks: 0,
        contradictions: 0,
      },
      elapsedMs: elapsed,
    };
  }

  commitDemoEmergencyChunk(chunk, elapsedMs, solveMetrics) {
    this.touchChunk(chunk);
    this.saveChunk(chunk);
    this.stats.generated += 1;
    this.stats.totalSolveTimeMs += elapsedMs;
    this.stats.maxSolveTimeMs = Math.max(this.stats.maxSolveTimeMs, elapsedMs);
    this.stats.generatedChunkRecords.push({
      cx: chunk.cx,
      cy: chunk.cy,
      elapsedMs,
      mode: solveMetrics?.mode || 'demo-emergency-fill',
      attempts: solveMetrics?.attempts ?? 1,
      backtracks: solveMetrics?.backtracks ?? 0,
      contradictions: solveMetrics?.contradictions ?? 0,
      checksum: chunk.checksum,
    });
    this.chunkChecksums.set(this.key(chunk.cx, chunk.cy), chunk.checksum);
    this.log(`generated emergency ${chunk.cx},${chunk.cy}`);
    return chunk;
  }

  repairSeams(chunk) {
    // Aggressive seam repair with constraint propagation
    const size = chunk.size;
    const grid = chunk.grid;
    let repaired = 0;
    const maxAttempts = 3;

    const neighbors = {
      left: this.getCommittedChunk(chunk.cx - 1, chunk.cy),
      right: this.getCommittedChunk(chunk.cx + 1, chunk.cy),
      top: this.getCommittedChunk(chunk.cx, chunk.cy - 1),
      bottom: this.getCommittedChunk(chunk.cx, chunk.cy + 1),
    };

    // Helper: get all tiles compatible with neighbor in given direction
    const getCompatibleTiles = (direction, neighborTile) => {
      if (!this.rules.propagator[direction] || !this.rules.propagator[direction][neighborTile]) {
        return new Set([12, 25]); // Fallback to self-compatible
      }
      return new Set(this.rules.propagator[direction][neighborTile]);
    };

    // Helper: get tiles that allow a neighbor in given direction
    const getTilesThatAllow = (direction, neighborTile) => {
      const result = new Set();
      for (let t = 0; t < Math.min(50, this.rules.tiles.length); t++) {
        if (this.rules.propagator[direction]?.[t]?.includes(neighborTile)) {
          result.add(t);
        }
      }
      return result.size > 0 ? result : new Set([12, 25]);
    };

    // Repair with multiple attempts (handle cascading fixes)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let fixed = 0;

      // LEFT seam (direction 0 = RIGHT from left neighbor's perspective)
      if (neighbors.left?.grid) {
        for (let row = 0; row < size; row++) {
          const leftTile = neighbors.left.grid[size - 1 + row * size];
          const thisIdx = row * size;
          const thisTile = grid[thisIdx];
          
          if (!this.rules.propagator[0]?.[leftTile]?.includes(thisTile)) {
            const compatible = getCompatibleTiles(0, leftTile);
            // Prefer tiles that don't break right seam if possible
            let bestTile = 12;
            for (const t of Array.from(compatible).sort((a, b) => {
              const aRight = neighbors.right ? 
                this.rules.propagator[0]?.[a]?.length ?? 0 : Infinity;
              const bRight = neighbors.right ? 
                this.rules.propagator[0]?.[b]?.length ?? 0 : Infinity;
              return bRight - aRight; // Prefer tiles with more right options
            })) {
              if (this.rules.tiles[t]) {
                bestTile = t;
                break;
              }
            }
            grid[thisIdx] = bestTile;
            fixed++;
          }
        }
      }

      // RIGHT seam (direction 0 = RIGHT)
      if (neighbors.right?.grid) {
        for (let row = 0; row < size; row++) {
          const thisIdx = size - 1 + row * size;
          const thisTile = grid[thisIdx];
          const rightTile = neighbors.right.grid[row * size];
          
          if (!this.rules.propagator[0]?.[thisTile]?.includes(rightTile)) {
            const allowedTiles = getTilesThatAllow(0, rightTile);
            let bestTile = 12;
            for (const t of Array.from(allowedTiles)) {
              if (this.rules.tiles[t]) {
                bestTile = t;
                break;
              }
            }
            grid[thisIdx] = bestTile;
            fixed++;
          }
        }
      }

      // TOP seam (direction 1 = DOWN from top neighbor's perspective)
      if (neighbors.top?.grid) {
        for (let col = 0; col < size; col++) {
          const topTile = neighbors.top.grid[col + (size - 1) * size];
          const thisIdx = col;
          const thisTile = grid[thisIdx];
          
          if (!this.rules.propagator[1]?.[topTile]?.includes(thisTile)) {
            const compatible = getCompatibleTiles(1, topTile);
            let bestTile = 12;
            for (const t of Array.from(compatible)) {
              if (this.rules.tiles[t]) {
                bestTile = t;
                break;
              }
            }
            grid[thisIdx] = bestTile;
            fixed++;
          }
        }
      }

      // BOTTOM seam (direction 1 = DOWN)
      if (neighbors.bottom?.grid) {
        for (let col = 0; col < size; col++) {
          const thisIdx = col + (size - 1) * size;
          const thisTile = grid[thisIdx];
          const bottomTile = neighbors.bottom.grid[col];
          
          if (!this.rules.propagator[1]?.[thisTile]?.includes(bottomTile)) {
            const allowedTiles = getTilesThatAllow(1, bottomTile);
            let bestTile = 12;
            for (const t of Array.from(allowedTiles)) {
              if (this.rules.tiles[t]) {
                bestTile = t;
                break;
              }
            }
            grid[thisIdx] = bestTile;
            fixed++;
          }
        }
      }

      repaired += fixed;
      if (fixed === 0) break; // No more violations fixable
    }

    if (repaired > 0) {
      chunk.checksum = checksumGrid(grid);
      chunk.seamsRepaired = repaired;
    }
    
    return repaired;
  }

  finalizeGeneratedChunk(chunk, elapsedMs, solveMetrics) {
    const neighbors = {
      left: this.getCommittedChunk(chunk.cx - 1, chunk.cy),
      right: this.getCommittedChunk(chunk.cx + 1, chunk.cy),
      top: this.getCommittedChunk(chunk.cx, chunk.cy - 1),
      bottom: this.getCommittedChunk(chunk.cx, chunk.cy + 1),
    };
    let internal = validateChunkInternal(chunk.grid, chunk.size, this.rules);
    let seam = validateChunkAgainstNeighbors(chunk, neighbors, this.rules);
    if (!internal.ok) this.stats.internalViolations += internal.violations.length;

    // Apply seam repair on a clone only, and only commit the repair if final checks pass.
    if (!seam.ok) {
      const repairedChunk = {
        ...chunk,
        grid: chunk.grid.slice(),
      };
      const repaired = this.repairSeams(repairedChunk);
      if (repaired > 0) {
        const repairedInternal = validateChunkInternal(repairedChunk.grid, repairedChunk.size, this.rules);
        const repairedSeam = validateChunkAgainstNeighbors(repairedChunk, neighbors, this.rules);
        if (repairedInternal.ok && repairedSeam.ok) {
          chunk.grid = repairedChunk.grid;
          chunk.checksum = repairedChunk.checksum;
          chunk.seamsRepaired = repaired;
          internal = repairedInternal;
          seam = repairedSeam;
          this.stats.seamsRepaired = (this.stats.seamsRepaired || 0) + repaired;
        }
      }
    }

    if (!seam.ok) this.stats.seamViolations += seam.violations.length;

    if (!internal.ok || !seam.ok) {
      this.log(`rejected chunk ${chunk.cx},${chunk.cy} mode=${solveMetrics?.mode || 'unknown'} internal=${internal.ok} seam=${seam.ok}`);
      return false;
    }

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
    return true;
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
    const policySolve = this.solveRegionWithConditionalBoundaryReseed(region, seed, label);
    if (policySolve?.solved?.grid) {
      solved = policySolve.solved;
      solveMetrics = policySolve.metrics;
    }

    if (!solved?.grid) {
      for (const result of this.solverAttempts(seed, region.seeded, region.width, region.height)) {
        if (result.grid) {
          solved = result;
          solveMetrics = result.metrics;
          break;
        }
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
    let committed = 0;
    for (const chunk of produced) {
      if (this.finalizeGeneratedChunk(chunk, perChunkElapsed, solveMetrics)) committed += 1;
    }
    if (committed === 0) return null;
    this.log(`generated ${label} ${minCx}:${maxCx},${minCy}:${maxCy}`);
    return committed;
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
        const target = this.getMemoryChunk(cx, cy) || this.loadChunkFromStorage(cx, cy);
        if (target) return target;
      }
    }

    const fallback = this.generateStructuredFallbackChunk(cx, cy);
    if (fallback) {
      const committed = this.finalizeGeneratedChunk(fallback, fallback.elapsedMs, fallback.metrics);
      if (committed) {
        if (fallback.metrics?.mode === 'minimal-tile-fallback') this.stats.fallbackStats.minimalTileSuccess += 1;
        else this.stats.fallbackStats.seamOnlySuccess += 1;
        this.log(`generated fallback ${cx},${cy} mode=${fallback.metrics?.mode || 'unknown'}`);
        return fallback;
      }
    }

    const resort = this.generateFullChunkResortChunk(cx, cy);
    if (resort) {
      const committed = this.finalizeGeneratedChunk(resort, resort.elapsedMs, resort.metrics);
      if (committed) {
        this.stats.fallbackStats.fullChunkResortUsed += 1;
        this.log(`generated full-chunk-resort ${cx},${cy}`);
        return resort;
      }
    }

    const emergency = this.generateDemoEmergencyChunk(cx, cy);
    if (emergency) {
      this.stats.fallbackStats.fullChunkResortUsed += 1;
      return this.commitDemoEmergencyChunk(emergency, emergency.elapsedMs, emergency.metrics);
    }

    this.stats.failedGenerations += 1;
    this.stats.fallbackStats.fallbackFailures += 1;
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

    const baseWidth = this.options.viewportWidth + pad * 2;
    const baseHeight = this.options.viewportHeight + pad * 2;
    const targetAspect = (typeof window !== 'undefined' && window.innerHeight > 0)
      ? (window.innerWidth / window.innerHeight)
      : (baseWidth / baseHeight);

    let width = baseWidth;
    let height = baseHeight;
    const baseAspect = baseWidth / baseHeight;

    // Expand the tile window to match display aspect ratio while keeping the
    // viewport centered. This avoids a square render on wide screens.
    if (baseAspect < targetAspect) {
      width = Math.max(baseWidth, Math.ceil(baseHeight * targetAspect));
    } else if (baseAspect > targetAspect) {
      height = Math.max(baseHeight, Math.ceil(baseWidth / targetAspect));
    }

    const viewportX = Math.floor((width - this.options.viewportWidth) / 2);
    const viewportY = Math.floor((height - this.options.viewportHeight) / 2);

    return {
      x: startX - viewportX,
      y: startY - viewportY,
      width,
      height,
      viewportX,
      viewportY,
    };
  }

  render(canvas) {
    const frame = this.renderWindow();
    const ctx = canvas.getContext('2d');
    const tileSize = TILE_SIZE;
    canvas.width = frame.width * TILE_SIZE;
    canvas.height = frame.height * TILE_SIZE;
    ctx.fillStyle = '#091321';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (let ty = 0; ty < frame.height; ty++) {
      for (let tx = 0; tx < frame.width; tx++) {
        const wx = frame.x + tx;
        const wy = frame.y + ty;
        const { cx, cy } = this.chunkCoordsForTile(wx, wy);
        const chunk = this.getMemoryChunk(cx, cy);
        const px = tx * TILE_SIZE;
        const py = ty * TILE_SIZE;

        if (chunk?.grid) {
          const lx = ((wx % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
          const ly = ((wy % this.options.chunkSize) + this.options.chunkSize) % this.options.chunkSize;
          const tile = this.rules.tiles[chunk.grid[lx + ly * this.options.chunkSize]];
          drawTile(ctx, tile, px, py, TILE_SIZE);
        } else if (this.queueSet.has(this.key(cx, cy)) || (this.activeJob && this.activeJob.cx === cx && this.activeJob.cy === cy)) {
          ctx.fillStyle = 'rgba(19,31,48,0.88)';
          ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
          ctx.strokeStyle = 'rgba(180,200,220,0.12)';
          ctx.beginPath();
          ctx.moveTo(px, py + TILE_SIZE);
          ctx.lineTo(px + TILE_SIZE, py);
          ctx.stroke();
        }
      }
    }

    for (const chunk of this.memory.values()) {
      if (chunk.flashUntil <= performance.now()) continue;
      const left = (chunk.cx * this.options.chunkSize - frame.x) * TILE_SIZE;
      const top = (chunk.cy * this.options.chunkSize - frame.y) * TILE_SIZE;
      const size = this.options.chunkSize * TILE_SIZE;
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
      ctx.moveTo(0, y * TILE_SIZE + 0.5);
      ctx.lineTo(canvas.width, y * TILE_SIZE + 0.5);
      ctx.stroke();
    }

    const chunkOffsetX = ((this.options.chunkSize - (frame.x % this.options.chunkSize)) % this.options.chunkSize);
    const chunkOffsetY = ((this.options.chunkSize - (frame.y % this.options.chunkSize)) % this.options.chunkSize);
    ctx.strokeStyle = 'rgba(143,211,255,0.24)';
    ctx.lineWidth = 2;
    for (let x = chunkOffsetX; x <= frame.width; x += this.options.chunkSize) {
      ctx.beginPath();
      ctx.moveTo(x * TILE_SIZE + 0.5, 0);
      ctx.lineTo(x * TILE_SIZE + 0.5, canvas.height);
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
      frame.viewportX * TILE_SIZE + 2,
      frame.viewportY * TILE_SIZE + 2,
      this.options.viewportWidth * TILE_SIZE - 4,
      this.options.viewportHeight * TILE_SIZE - 4
    );

    const playerPx = (this.player.x - frame.x) * TILE_SIZE;
    const playerPy = (this.player.y - frame.y) * TILE_SIZE;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(playerPx + 4, playerPy + 4, TILE_SIZE - 8, TILE_SIZE - 8);
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
    up: document.getElementById('upBtn'),
    left: document.getElementById('leftBtn'),
    down: document.getElementById('downBtn'),
    right: document.getElementById('rightBtn'),
  };

  if (!els.canvas) return;

  let rules = null;
  let world = null;

  function appendLog(message) {
    if (!els.log) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    els.log.prepend(entry);
    while (els.log.children.length > MAX_DEMO_LOG_ENTRIES) els.log.removeChild(els.log.lastChild);
  }

  function setStatus(message) {
    if (els.status) els.status.textContent = message;
  }

  function updateStats() {
    if (!world || !els.stats) return;
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
    const numberValue = (el, fallback) => {
      if (!el) return fallback;
      const value = Number(el.value);
      return Number.isFinite(value) ? value : fallback;
    };

    return {
      seed: numberValue(els.seed, PRESET.seed),
      chunkSize: numberValue(els.chunkSize, PRESET.chunkSize),
      viewportWidth: numberValue(els.viewportWidth, PRESET.viewportWidth),
      viewportHeight: numberValue(els.viewportHeight, PRESET.viewportHeight),
      memoryLimit: numberValue(els.memoryLimit, PRESET.memoryLimit),
      frontierTrigger: numberValue(els.frontier, PRESET.frontierTrigger),
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
    if (els.seed) els.seed.value = PRESET.seed;
    if (els.chunkSize) els.chunkSize.value = PRESET.chunkSize;
    if (els.viewportWidth) els.viewportWidth.value = PRESET.viewportWidth;
    if (els.viewportHeight) els.viewportHeight.value = PRESET.viewportHeight;
    if (els.memoryLimit) els.memoryLimit.value = PRESET.memoryLimit;
    if (els.frontier) els.frontier.value = PRESET.frontierTrigger;
    setStatus('Demo preset applied. Use left/right to generate ahead, evict behind, and reload identical chunks on return.');
  }

  async function resetWorld() {
    if (!rules) rules = await loadSummerRules();
    if (els.log) els.log.innerHTML = '';
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

  if (els.applyPreset) els.applyPreset.onclick = applyPreset;
  if (els.reset) els.reset.onclick = () => { resetWorld(); };
  if (els.clearStorage) {
    els.clearStorage.onclick = () => {
      clearDemoStorage();
      resetWorld();
    };
  }
  if (els.up) els.up.onclick = () => move(0, -1);
  if (els.left) els.left.onclick = () => move(-1, 0);
  if (els.down) els.down.onclick = () => move(0, 1);
  if (els.right) els.right.onclick = () => move(1, 0);

  document.addEventListener('keydown', event => {
    if (event.repeat) return;
    const activeTag = document.activeElement?.tagName || '';
    if (['INPUT', 'TEXTAREA'].includes(activeTag)) return;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const map = {
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      w: [0, -1],
      s: [0, 1],
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
