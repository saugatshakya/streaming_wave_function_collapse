/**
 * utils.js - Shared utility functions used across world managers
 * Extracted to reduce code duplication between DemoWorld and WorldManager
 */

/**
 * Helper color function for rendering tiles when image is unavailable
 * @param {string} name - Tile name to determine color
 * @returns {string} Hex color code
 */
export function getTileColor(name) {
  if (name.startsWith('water')) return '#3fa7f0';
  if (name.startsWith('road')) return '#d9be7c';
  if (name.startsWith('cliff')) return '#70411f';
  return '#65b93c';
}

/**
 * FNV-1a 32-bit hash function for checksums
 * @param {Array<number>} grid - Grid of tile IDs to hash
 * @returns {number} Hash value
 */
export function checksumGrid(grid) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < grid.length; i++) {
    hash ^= grid[i] + 1;
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Get reverse allowed tiles from propagator
 * Finds which tiles can appear in a given direction before a committed tile
 * @param {Object} rules - WFC rules object with propagator
 * @param {number} direction - Direction index (0-3: right, down, left, up)
 * @param {number} committedTile - The committed tile to reverse-lookup
 * @returns {Set<number>} Set of tile IDs allowed before this tile
 */
export function getAllowedTilesForCommittedNeighbor(rules, direction, committedTile) {
  const allowed = new Set();
  for (let tile = 0; tile < rules.tileCount; tile++) {
    if (rules.propagator[direction][tile].includes(committedTile)) {
      allowed.add(tile);
    }
  }
  return allowed;
}

/**
 * Clamp a value between min and max
 * @param {number} value - Value to clamp
 * @param {number} min - Minimum value
 * @param {number} max - Maximum value
 * @returns {number} Clamped value
 */
export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Generate a coordinate key for caching
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @returns {string} Coordinate key
 */
export function coordKey(x, y) {
  return `${x},${y}`;
}

/**
 * Parse a coordinate key back into x, y
 * @param {string} key - Coordinate key
 * @returns {{x: number, y: number}} Parsed coordinates
 */
export function parseCoordKey(key) {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
}

/**
 * Manhattan distance between two coordinates
 * @param {number} x1 - First X
 * @param {number} y1 - First Y
 * @param {number} x2 - Second X
 * @param {number} y2 - Second Y
 * @returns {number} Manhattan distance
 */
export function manhattanDistance(x1, y1, x2, y2) {
  return Math.abs(x1 - x2) + Math.abs(y1 - y2);
}

/**
 * Check if coordinate is within bounds
 * @param {number} x - X coordinate
 * @param {number} y - Y coordinate
 * @param {number} minX - Minimum X (inclusive)
 * @param {number} maxX - Maximum X (inclusive)
 * @param {number} minY - Minimum Y (inclusive)
 * @param {number} maxY - Maximum Y (inclusive)
 * @returns {boolean} True if within bounds
 */
export function isInBounds(x, y, minX, maxX, minY, maxY) {
  return x >= minX && x <= maxX && y >= minY && y <= maxY;
}

/**
 * Create a deep clone of a simple object
 * @param {Object} obj - Object to clone
 * @returns {Object} Cloned object
 */
export function shallowClone(obj) {
  if (Array.isArray(obj)) return obj.slice();
  if (obj !== null && typeof obj === 'object') {
    return Object.assign({}, obj);
  }
  return obj;
}
