const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

export function validateChunkInternal(grid, size, rules) {
  if (!grid) return { ok: false, violations: [{ type: 'null-grid' }] };
  const violations = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = x + y * size;
      const t = grid[i];
      for (let d = 0; d < 2; d++) {
        const nx = x + DX[d];
        const ny = y + DY[d];
        if (nx >= size || ny >= size) continue;
        const ni = nx + ny * size;
        const nt = grid[ni];
        if (!rules.propagator[d][t].includes(nt)) {
          violations.push({ x, y, d, t, nt });
        }
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

export function validateChunkAgainstNeighbors(chunk, neighbors, rules) {
  const size = chunk.size;
  const violations = [];
  if (!chunk.grid) return { ok: false, violations: [{ type: 'null-grid' }] };

  if (neighbors.left?.grid) {
    for (let row = 0; row < size; row++) {
      const a = neighbors.left.grid[size - 1 + row * size];
      const b = chunk.grid[row * size];
      if (!rules.propagator[0][a].includes(b)) violations.push({ side: 'left', row, a, b });
    }
  }
  if (neighbors.right?.grid) {
    for (let row = 0; row < size; row++) {
      const a = chunk.grid[size - 1 + row * size];
      const b = neighbors.right.grid[row * size];
      if (!rules.propagator[0][a].includes(b)) violations.push({ side: 'right', row, a, b });
    }
  }
  if (neighbors.top?.grid) {
    for (let col = 0; col < size; col++) {
      const a = neighbors.top.grid[col + (size - 1) * size];
      const b = chunk.grid[col];
      if (!rules.propagator[1][a].includes(b)) violations.push({ side: 'top', col, a, b });
    }
  }
  if (neighbors.bottom?.grid) {
    for (let col = 0; col < size; col++) {
      const a = chunk.grid[col + (size - 1) * size];
      const b = neighbors.bottom.grid[col];
      if (!rules.propagator[1][a].includes(b)) violations.push({ side: 'bottom', col, a, b });
    }
  }

  return { ok: violations.length === 0, violations };
}
