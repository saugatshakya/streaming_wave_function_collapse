import { getTileColor } from './utils.js';

function drawFallback(ctx, x, y, s, tile) {
  const name = tile.name;
  ctx.fillStyle = getTileColor(name);
  ctx.fillRect(x, y, s, s);
}

function drawTileImage(ctx, x, y, size, tile) {
  if (tile?.image) ctx.drawImage(tile.image, x, y, size, size);
  else drawFallback(ctx, x, y, size, tile || { name: 'grass' });
}

function drawMaskedPreview(ctx, x, y, size, alpha = 0.55) {
  ctx.fillStyle = `rgba(15,24,36,${alpha})`;
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = 'rgba(180, 200, 220, 0.12)';
  ctx.beginPath();
  ctx.moveTo(x, y + size);
  ctx.lineTo(x + size, y);
  ctx.stroke();
}

export function drawSample(canvas, rows, rules, tileSize = 20) {
  const width = rows[0].length;
  const height = rows.length;
  canvas.width = width * tileSize;
  canvas.height = height * tileSize;
  const ctx = canvas.getContext('2d');
  rows.forEach((row, y) => row.forEach((name, x) => {
    const variant = rules.tiles.find(t => `${t.name} ${t.orientation}` === name) || rules.tiles.find(t => t.name === 'grass');
    drawTileImage(ctx, x * tileSize, y * tileSize, tileSize, variant);
  }));
}

function previewValueForChunk(chunk, lx, ly) {
  if (!chunk.preview || !chunk.region) return null;
  const regionMinCx = chunk.region.minCx;
  const regionMinCy = chunk.region.minCy;
  const halo = chunk.previewHalo || 0;
  const ox = halo + (chunk.cx - regionMinCx) * chunk.size;
  const oy = halo + (chunk.cy - regionMinCy) * chunk.size;
  const idx = (ox + lx) + (oy + ly) * chunk.previewWidth;
  return chunk.preview[idx] ?? null;
}

export function drawViewport(canvas, { world, rules, tileSize = 24 }) {
  const frame = world.renderWindow();
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.error('Failed to get 2D canvas context');
    return;
  }
  const chunkCache = new Map();
  canvas.width = frame.width * tileSize;
  canvas.height = frame.height * tileSize;
  ctx.fillStyle = '#07111d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const frontierKeys = world.frontierKeySet();
  for (let ty = 0; ty < frame.height; ty++) {
    for (let tx = 0; tx < frame.width; tx++) {
      const worldX = frame.x + tx;
      const worldY = frame.y + ty;
      const px = tx * tileSize;
      const py = ty * tileSize;
      const { cx, cy } = world.chunkCoordsForTile(worldX, worldY);
      const key = world.key(cx, cy);
      if (!chunkCache.has(key)) {
        chunkCache.set(key, world.memory.get(key) || world.getReadyChunk(cx, cy) || null);
      }
      const chunk = chunkCache.get(key);
      if (!chunk) continue;
      const lx = ((worldX % world.chunkSize) + world.chunkSize) % world.chunkSize;
      const ly = ((worldY % world.chunkSize) + world.chunkSize) % world.chunkSize;
      const index = lx + ly * world.chunkSize;

      if (chunk.state === 'queued' || chunk.state === 'solving') {
        if (!frontierKeys.has(key)) continue;
        const seededTile = previewValueForChunk(chunk, lx, ly);
        if (seededTile instanceof Set && seededTile.size === 1) drawTileImage(ctx, px, py, tileSize, rules.tiles[[...seededTile][0]]);
        else if (typeof seededTile === 'number') drawTileImage(ctx, px, py, tileSize, rules.tiles[seededTile]);
        else drawMaskedPreview(ctx, px, py, tileSize, chunk.state === 'queued' ? 0.45 : 0.5);
      } else if (chunk.state === 'animating') {
        const total = chunk.grid.length;
        const visible = Math.floor(total * chunk.revealProgress);
        if (index < visible) drawTileImage(ctx, px, py, tileSize, rules.tiles[chunk.grid[index]]);
        else drawMaskedPreview(ctx, px, py, tileSize, 0.55);
      } else if (chunk.grid) {
        drawTileImage(ctx, px, py, tileSize, rules.tiles[chunk.grid[index]]);
      }
    }
  }

  ctx.strokeStyle = 'rgba(180, 200, 220, 0.14)';
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

  ctx.strokeStyle = 'rgba(170, 220, 255, 0.34)';
  ctx.lineWidth = 2;
  const chunkOffsetX = ((world.chunkSize - (frame.x % world.chunkSize)) % world.chunkSize);
  const chunkOffsetY = ((world.chunkSize - (frame.y % world.chunkSize)) % world.chunkSize);
  for (let x = chunkOffsetX; x <= frame.width; x += world.chunkSize) {
    ctx.beginPath();
    ctx.moveTo(x * tileSize + 0.5, 0);
    ctx.lineTo(x * tileSize + 0.5, canvas.height);
    ctx.stroke();
  }
  for (let y = chunkOffsetY; y <= frame.height; y += world.chunkSize) {
    ctx.beginPath();
    ctx.moveTo(0, y * tileSize + 0.5);
    ctx.lineTo(canvas.width, y * tileSize + 0.5);
    ctx.stroke();
  }

  const vx = frame.margin.left * tileSize;
  const vy = frame.margin.top * tileSize;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 4;
  ctx.strokeRect(vx + 1.5, vy + 1.5, world.viewportWidth * tileSize - 3, world.viewportHeight * tileSize - 3);

  const playerPx = (world.player.x - frame.x) * tileSize;
  const playerPy = (world.player.y - frame.y) * tileSize;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 4;
  ctx.strokeRect(playerPx + 3, playerPy + 3, tileSize - 6, tileSize - 6);
}
