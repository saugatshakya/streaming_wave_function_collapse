/**
 * worldCommon.js - Shared utilities for DemoWorld and WorldManager
 * Extracted to eliminate 90% code duplication between demo.js and world.js
 * 
 * These are pure, dependency-free functions used by both world managers for:
 * - Coordinate transformations
 * - Storage I/O operations
 * - Memory/LRU cache management
 * - Visible range calculations
 * - Direction tracking
 */

/**
 * Generate a string key from chunk coordinates
 * Used as cache key in memory maps and chunk lookup
 * @param {number} cx - Chunk X coordinate
 * @param {number} cy - Chunk Y coordinate
 * @returns {string} Key in format "cx,cy"
 */
export function chunkKey(cx, cy) {
  return `${cx},${cy}`;
}

/**
 * Convert world coordinates to chunk coordinates
 * @param {number} chunkSize - Size of chunks
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate
 * @returns {{cx: number, cy: number}} Chunk coordinates
 */
export function chunkCoordsForTile(chunkSize, x, y) {
  return {
    cx: Math.floor(x / chunkSize),
    cy: Math.floor(y / chunkSize),
  };
}

/**
 * Build a storage key with prefix and coordinates
 * Format: "{prefix}{cx},{cy}"
 * @param {string} prefix - Storage prefix (includes seed, chunk size, etc.)
 * @param {number} cx - Chunk X coordinate
 * @param {number} cy - Chunk Y coordinate
 * @returns {string} Full storage key
 */
export function buildStorageKey(prefix, cx, cy) {
  return `${prefix}${cx},${cy}`;
}

/**
 * Load chunk from localStorage with optional validation
 * Safely handles missing localStorage, parsing errors, and invalid data
 * 
 * @param {string} storageKey - The localStorage key
 * @param {Function} validator - Optional validation function (chunk) => boolean
 * @returns {Object|null} - Parsed chunk or null if not found/invalid
 */
export function loadChunkFromStorage(storageKey, validator = null) {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed) return null;
    if (validator && !validator(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save chunk to localStorage
 * Only persists essential fields to minimize storage size
 * 
 * @param {string} storageKey - The localStorage key
 * @param {Object} chunk - Chunk to save (must have cx, cy, grid, seed, size)
 * @returns {void}
 */
export function saveChunkToStorage(storageKey, chunk) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      cx: chunk.cx,
      cy: chunk.cy,
      grid: chunk.grid,
      seed: chunk.seed,
      size: chunk.size,
    }));
  } catch {
    // Storage full or quota exceeded - silently fail
  }
}

/**
 * Update LRU cache: remove and re-add for recency
 * Maintains insertion order for LRU eviction
 * 
 * @param {Map} memoryMap - The memory cache map
 * @param {string} key - The entry key
 * @param {Object} value - The chunk/entry to cache
 * @returns {number} - New size of cache after touch
 */
export function touchMemoryLRU(memoryMap, key, value) {
  if (memoryMap.has(key)) memoryMap.delete(key);
  memoryMap.set(key, value);
  return memoryMap.size;
}

/**
 * Retrieve tile value at world coordinates
 * Handles negative coordinates with modulo wrapping
 * 
 * @param {Object} chunk - Chunk object with grid array
 * @param {number} chunkSize - Size of chunk
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate
 * @returns {number|null} - Tile ID or null if chunk missing
 */
export function tileAtCoords(chunk, chunkSize, x, y) {
  if (!chunk?.grid) return null;
  const lx = ((x % chunkSize) + chunkSize) % chunkSize;
  const ly = ((y % chunkSize) + chunkSize) % chunkSize;
  return chunk.grid[lx + ly * chunkSize];
}

/**
 * Calculate visible chunk range from player position
 * Returns min/max chunk coordinates visible in viewport
 * 
 * @param {number} chunkSize - Size of chunks
 * @param {number} playerX - Player world X coordinate
 * @param {number} playerY - Player world Y coordinate
 * @param {number} viewportWidth - Width in chunks
 * @param {number} viewportHeight - Height in chunks
 * @returns {{min: {cx: number, cy: number}, max: {cx: number, cy: number}}} Range of visible chunks
 */
export function calculateVisibleChunkRange(chunkSize, playerX, playerY, viewportWidth, viewportHeight) {
  const halfW = Math.floor(viewportWidth / 2);
  const halfH = Math.floor(viewportHeight / 2);
  const startX = playerX - halfW;
  const startY = playerY - halfH;
  const endX = startX + viewportWidth - 1;
  const endY = startY + viewportHeight - 1;
  
  return {
    min: chunkCoordsForTile(chunkSize, startX, startY),
    max: chunkCoordsForTile(chunkSize, endX, endY),
  };
}

/**
 * Calculate Manhattan distance between chunks
 * Used for LRU culling and region-based memory management
 * 
 * @param {number} cx1 - First chunk X
 * @param {number} cy1 - First chunk Y
 * @param {number} cx2 - Second chunk X
 * @param {number} cy2 - Second chunk Y
 * @returns {number} Manhattan distance in chunks
 */
export function chunkDistance(cx1, cy1, cx2, cy2) {
  return Math.abs(cx1 - cx2) + Math.abs(cy1 - cy2);
}

/**
 * Convert directional deltas to direction string
 * Maps (dx, dy) to cardinal direction names
 * 
 * @param {number} dx - X delta (-1, 0, or 1)
 * @param {number} dy - Y delta (-1, 0, or 1)
 * @returns {string|null} - Direction ('right', 'left', 'down', 'up') or null
 */
export function directionFromDelta(dx, dy) {
  if (dx === 1) return 'right';
  if (dx === -1) return 'left';
  if (dy === 1) return 'down';
  if (dy === -1) return 'up';
  return null;
}

/**
 * Calculate local position within chunk
 * Converts world coordinates to chunk-local coordinates
 * 
 * @param {number} chunkSize - Size of chunk
 * @param {number} x - World X coordinate
 * @param {number} y - World Y coordinate
 * @returns {{lx: number, ly: number}} Local coordinates within chunk
 */
export function localCoordsInChunk(chunkSize, x, y) {
  return {
    lx: ((x % chunkSize) + chunkSize) % chunkSize,
    ly: ((y % chunkSize) + chunkSize) % chunkSize,
  };
}

/**
 * Check if a coordinate is within a rectangular region
 * @param {number} x - X coordinate to check
 * @param {number} y - Y coordinate to check
 * @param {number} startX - Region left boundary (inclusive)
 * @param {number} endX - Region right boundary (inclusive)
 * @param {number} startY - Region top boundary (inclusive)
 * @param {number} endY - Region bottom boundary (inclusive)
 * @returns {boolean} True if within bounds
 */
export function isInRegion(x, y, startX, endX, startY, endY) {
  return x >= startX && x <= endX && y >= startY && y <= endY;
}

/**
 * Compute checksum of grid for consistency verification
 * Uses FNV-1a 32-bit hash algorithm for quick comparison
 * 
 * @param {Array<number>} grid - Array of tile IDs
 * @returns {number} Hash value
 */
export function checksumWorld(grid) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < grid.length; i++) {
    hash ^= grid[i] + 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
