import { mulberry32, shuffleInPlace } from './rng.js';

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
const OPPOSITE = [2, 3, 0, 1];

function computeEntropy(waveCell, weights) {
  let amount = 0;
  let sum = 0;
  let sumLog = 0;
  for (let t = 0; t < waveCell.length; t++) {
    if (!waveCell[t]) continue;
    amount++;
    const w = weights[t];
    sum += w;
    sumLog += w * Math.log(w);
  }
  if (amount <= 1) return Infinity;
  return Math.log(sum) - sumLog / sum;
}

function cloneState(state) {
  return {
    width: state.width,
    height: state.height,
    T: state.T,
    propagator: state.propagator,
    weights: state.weights,
    wave: state.wave.map(row => row.slice()),
    compatible: state.compatible.map(cell => cell.map(counts => counts.slice())),
    counts: state.counts.slice(),
    lastContradictionIndex: state.lastContradictionIndex,
  };
}

function createState(width, height, rules) {
  const cells = width * height;
  const wave = new Array(cells);
  const compatible = new Array(cells);
  const counts = new Array(cells).fill(rules.tileCount);
  for (let i = 0; i < cells; i++) {
    wave[i] = new Array(rules.tileCount).fill(true);
    compatible[i] = new Array(rules.tileCount);
    for (let t = 0; t < rules.tileCount; t++) {
      compatible[i][t] = [
        rules.propagator[0][t].length,
        rules.propagator[1][t].length,
        rules.propagator[2][t].length,
        rules.propagator[3][t].length,
      ];
    }
  }
  return {
    width,
    height,
    T: rules.tileCount,
    propagator: rules.propagator,
    weights: rules.weights,
    wave,
    compatible,
    counts,
    lastContradictionIndex: null,
  };
}

function recordCompatibleChange(changes, index, tile, dir, prev) {
  changes.push({ kind: 'compatible', index, tile, dir, prev });
}

function recordCountChange(changes, index, prev) {
  changes.push({ kind: 'count', index, prev });
}

function recordWaveChange(changes, index, tile) {
  changes.push({ kind: 'wave', index, tile });
}

function ban(state, index, tile, stack, changes) {
  if (!state.wave[index][tile]) return true;
  recordWaveChange(changes, index, tile);
  recordCountChange(changes, index, state.counts[index]);
  state.wave[index][tile] = false;
  state.counts[index] -= 1;
  stack.push([index, tile]);
  if (state.counts[index] <= 0) state.lastContradictionIndex = index;
  return state.counts[index] > 0;
}

function propagate(state, stack, changes) {
  while (stack.length > 0) {
    const [i, t] = stack.pop();
    const x = i % state.width;
    const y = Math.floor(i / state.width);

    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= state.width || ny >= state.height) continue;
      const ni = nx + ny * state.width;
      const allowed = state.propagator[d][t];
      for (let k = 0; k < allowed.length; k++) {
        const t2 = allowed[k];
        const dir = OPPOSITE[d];
        const prev = state.compatible[ni][t2][dir];
        if (prev <= 0) continue;
        recordCompatibleChange(changes, ni, t2, dir, prev);
        state.compatible[ni][t2][dir] = prev - 1;
        if (state.compatible[ni][t2][dir] === 0) {
          if (!ban(state, ni, t2, stack, changes)) return false;
        }
      }
    }
  }
  return true;
}

function applySeededCells(state, seededCells) {
  const stack = [];
  const changes = [];
  for (const [index, allowedValues] of seededCells.entries()) {
    const allowedSet = allowedValues instanceof Set ? allowedValues : new Set(allowedValues);
    if (allowedSet.size === 0) return false;
    for (let t = 0; t < state.T; t++) {
      if (!allowedSet.has(t)) {
        if (!ban(state, index, t, stack, changes)) return false;
      }
    }
  }
  return propagate(state, stack, changes);
}

function chooseCell(state, random) {
  let best = -1;
  let bestEntropy = Infinity;
  for (let i = 0; i < state.wave.length; i++) {
    if (state.counts[i] === 0) {
      state.lastContradictionIndex = i;
      return -2;
    }
    if (state.counts[i] <= 1) continue;
    const entropy = computeEntropy(state.wave[i], state.weights) + random() * 1e-6;
    if (entropy < bestEntropy) {
      bestEntropy = entropy;
      best = i;
    }
  }
  return best;
}

function orderedOptions(state, index, random) {
  const opts = [];
  for (let t = 0; t < state.T; t++) if (state.wave[index][t]) opts.push(t);
  opts.sort((a, b) => state.weights[b] - state.weights[a]);
  const groups = new Map();
  for (const t of opts) {
    const key = state.weights[t].toFixed(4);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }
  const merged = [];
  for (const [, group] of groups) {
    shuffleInPlace(group, random);
    merged.push(...group);
  }
  return merged;
}

function collapseToTile(parentState, index, chosen) {
  const stack = [];
  const changes = [];
  for (let t = 0; t < parentState.T; t++) {
    if (t !== chosen) {
      if (!ban(parentState, index, t, stack, changes)) {
        undoChanges(parentState, changes);
        return null;
      }
    }
  }
  if (!propagate(parentState, stack, changes)) {
    undoChanges(parentState, changes);
    return null;
  }
  return changes;
}

function undoChanges(state, changes) {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i];
    if (change.kind === 'compatible') {
      state.compatible[change.index][change.tile][change.dir] = change.prev;
    } else if (change.kind === 'count') {
      state.counts[change.index] = change.prev;
    } else if (change.kind === 'wave') {
      state.wave[change.index][change.tile] = true;
    }
  }
}

const TIMEOUT = Symbol('timeout');

function solveByBacktracking(baseState, seed, maxTimeMs = Number.POSITIVE_INFINITY) {
  const metrics = {
    mode: 'backtracking',
    timeMs: 0,
    attempts: 1,
    backtracks: 0,
    observations: 0,
    contradictions: 0,
    timedOut: false,
    lastContradictionIndex: null,
  };
  const start = performance.now();
  const deadline = start + maxTimeMs;

  function dfs(state, depth) {
    if (performance.now() > deadline) return TIMEOUT;
    const pickRandom = mulberry32((seed + depth * 2654435761) >>> 0);
    const cell = chooseCell(state, pickRandom);
    if (cell === -2) {
      metrics.contradictions += 1;
      metrics.lastContradictionIndex = state.lastContradictionIndex;
      return null;
    }
    if (cell === -1) return state;
    metrics.observations += 1;
    const options = orderedOptions(state, cell, pickRandom);
    for (const tile of options) {
      const changes = collapseToTile(state, cell, tile);
      if (!changes) {
        metrics.backtracks += 1;
        metrics.contradictions += 1;
        metrics.lastContradictionIndex = state.lastContradictionIndex ?? cell;
        continue;
      }
      const solved = dfs(state, depth + 1);
      if (solved === TIMEOUT) return TIMEOUT;
      if (solved) return solved;
      undoChanges(state, changes);
      metrics.backtracks += 1;
    }
    return null;
  }

  const solved = dfs(baseState, 0);
  if (solved === TIMEOUT) {
    metrics.timedOut = true;
    metrics.timeMs = performance.now() - start;
    return { state: null, metrics };
  }
  metrics.timeMs = performance.now() - start;
  return { state: solved, metrics };
}

function solveByRestart(baseState, seed, maxRestarts = 50, maxTimeMs = Number.POSITIVE_INFINITY) {
  const start = performance.now();
  const deadline = start + maxTimeMs;
  const metrics = {
    mode: 'restart',
    timeMs: 0,
    attempts: 0,
    backtracks: 0,
    observations: 0,
    contradictions: 0,
    timedOut: false,
    lastContradictionIndex: null,
  };
  for (let attempt = 0; attempt < maxRestarts; attempt++) {
    if (performance.now() > deadline) {
      metrics.timedOut = true;
      break;
    }
    metrics.attempts += 1;
    let state = cloneState(baseState);
    const random = mulberry32((seed + attempt * 2246822519) >>> 0);
    while (true) {
      const cell = chooseCell(state, random);
      if (cell === -2) {
        metrics.contradictions += 1;
        metrics.lastContradictionIndex = state.lastContradictionIndex;
        break;
      }
      if (cell === -1) {
        metrics.timeMs = performance.now() - start;
        return { state, metrics };
      }
      metrics.observations += 1;
      const options = orderedOptions(state, cell, random);
      const chosen = options[Math.floor(random() * options.length)];
      const next = cloneState(state);
      const changes = collapseToTile(next, cell, chosen);
      if (!changes) {
        metrics.contradictions += 1;
        metrics.lastContradictionIndex = next.lastContradictionIndex ?? cell;
        break;
      }
      state = next;
    }
  }
  metrics.timeMs = performance.now() - start;
  return { state: null, metrics };
}

export class WFCSolver {
  constructor({ size = null, width = null, height = null, rules, seed, seededCells = new Map(), mode = 'backtracking', maxRestarts = 50, maxTimeMs = Number.POSITIVE_INFINITY }) {
    this.width = width ?? size;
    this.height = height ?? size;
    this.rules = rules;
    this.seed = seed >>> 0;
    this.seededCells = seededCells;
    this.mode = mode;
    this.maxRestarts = maxRestarts;
    this.maxTimeMs = maxTimeMs;
  }

  solve() {
    const state = createState(this.width, this.height, this.rules);
    if (!applySeededCells(state, this.seededCells)) {
      const contradictionIndex = Number.isInteger(state.lastContradictionIndex) ? state.lastContradictionIndex : null;
      return {
        grid: null,
        metrics: {
          mode: this.mode,
          timeMs: 0,
          attempts: this.mode === 'restart' ? this.maxRestarts : 1,
          backtracks: 0,
          observations: 0,
          contradictions: 1,
          timedOut: false,
          lastContradictionIndex: contradictionIndex,
          contradictionCell: contradictionIndex === null
            ? null
            : { index: contradictionIndex, x: contradictionIndex % this.width, y: Math.floor(contradictionIndex / this.width) },
        },
      };
    }
    const result = this.mode === 'restart'
      ? solveByRestart(state, this.seed, this.maxRestarts, this.maxTimeMs)
      : solveByBacktracking(state, this.seed, this.maxTimeMs);
    const grid = result.state ? result.state.wave.map(cell => cell.findIndex(Boolean)) : null;
    const validGrid = grid && grid.every(tile => tile >= 0);
    if (grid && !validGrid) {
      result.metrics.contradictions += 1;
    }
    const contradictionIndex = Number.isInteger(result.metrics.lastContradictionIndex)
      ? result.metrics.lastContradictionIndex
      : null;
    return {
      grid: validGrid ? grid : null,
      width: this.width,
      height: this.height,
      metrics: {
        ...result.metrics,
        contradictionCell: contradictionIndex === null
          ? null
          : { index: contradictionIndex, x: contradictionIndex % this.width, y: Math.floor(contradictionIndex / this.width) },
      },
    };
  }
}
