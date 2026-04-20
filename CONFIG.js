/**
 * CONFIG.js - Centralized configuration constants
 * This file consolidates all magic numbers and configuration values used across the project.
 */

// ============================================================================
// TIMING & PERFORMANCE CONSTANTS
// ============================================================================

/** Maximum milliseconds for solver to run per chunk in demo mode */
export const DEMO_SOLVER_MAX_TIME_MS = 180;

/** Interval for rendering stats updates (milliseconds) */
export const STATS_RENDER_INTERVAL_MS = 180;

/** Delay before processing queued chunks (milliseconds) */
export const QUEUE_DELAY_MS = 50;

/** Default time for chunk solving (milliseconds) */
export const CHUNK_SOLVE_MS = 90;

/** Time for restart solver (milliseconds) */
export const RESTART_SOLVE_MS = 140;

/** Time for deep solve (milliseconds) */
export const DEEP_SOLVE_MS = 280;

/** Demo mode: preview solve time (milliseconds) */
export const DEMO_SOLVE_PREVIEW_MS = 18;

/** Production mode: preview solve time (milliseconds) */
export const PROD_SOLVE_PREVIEW_MS = 80;

/** Demo mode: reveal animation duration (milliseconds) */
export const DEMO_REVEAL_DURATION_MS = 60;

/** Production mode: reveal animation duration (milliseconds) */
export const PROD_REVEAL_DURATION_MS = 160;

/** Controlled experiment max time (milliseconds) */
export const CONTROLLED_MAX_TIME_MS = 5000;

/** Default animation frame duration (milliseconds) */
export const ANIMATION_FRAME_MS = 24;

/** Settlement frame count for async transitions */
export const SETTLEMENT_FRAMES = 6;

// ============================================================================
// UI & RENDERING CONSTANTS
// ============================================================================

/** Tile size for rendering in pixels */
export const TILE_SIZE = 28;

/** Default tile size in renderer (fallback) */
export const DEFAULT_TILE_SIZE = 24;

/** JPEG compression quality for image capture */
export const JPEG_QUALITY = 0.32;

/** Maximum entries in event log */
export const MAX_LOG_ENTRIES = 160;

/** Maximum entries in demo event log */
export const MAX_DEMO_LOG_ENTRIES = 40;

// ============================================================================
// SPATIAL & MEMORY CONSTANTS
// ============================================================================

/** Default memory/cache limit for chunks */
export const DEFAULT_CACHE_LIMIT = 12;

/** Default minimum memory chunk limit */
export const MIN_MEMORY_CHUNK_LIMIT = 4;

/** Memory chunk limits by chunk size */
export const MEMORY_CHUNK_LIMITS = {
  small: 20,    // chunkSize <= 10
  medium: 8,    // chunkSize <= 20
  large: 4,     // chunkSize > 20
};

/** Memory keep radius for chunk retention */
export const MEMORY_KEEP_RADIUS = {
  small: 1,     // chunkSize <= 10
  medium: 0,    // chunkSize <= 20
  large: 0,     // chunkSize > 20
};

/** Default outer padding tiles for render window */
export const DEFAULT_OUTER_PADDING_TILES = 4;

/** Minimum frontier distance for chunk generation */
export const MIN_FRONTIER_DISTANCE = 2;

// ============================================================================
// WORLD GENERATION CONSTANTS
// ============================================================================

/** Chunk size thresholds for adaptive policies */
export const CHUNK_SIZE_THRESHOLDS = {
  small: 10,    // small and below
  medium: 20,   // small to medium
  // anything above medium is large
};

/** Player start position multiplier from chunk size */
export const PLAYER_START_MULTIPLIER = 1.5;

/** Render viewport padding multiplier */
export const RENDER_PADDING = 4;

/** Default frontier trigger distance */
export const DEFAULT_FRONTIER_TRIGGER = 2;

// ============================================================================
// DEFAULT PRESET VALUES
// ============================================================================

/** Demo preset configuration for presentation mode */
export const DEMO_PRESET = Object.freeze({
  seed: 3566155852,
  chunkSize: 10,
  viewportWidth: 8,
  viewportHeight: 8,
  memoryLimit: 8,
  frontierTrigger: 2,
  renderPadding: 4,
  queueDelayMs: QUEUE_DELAY_MS,
  chunkSolveMs: CHUNK_SOLVE_MS,
  restartSolveMs: RESTART_SOLVE_MS,
  deepSolveMs: DEEP_SOLVE_MS,
});

/** Main index.html preset configuration */
export const MAIN_PRESET = Object.freeze({
  worldSeed: 3566155852,
  cacheLimit: DEFAULT_CACHE_LIMIT,
  chunkSize: 10,
  viewportWidth: 8,
  viewportHeight: 8,
});

// ============================================================================
// EXPERIMENT CONSTANTS
// ============================================================================

/** Number of controlled runs for experimentation */
export const CONTROLLED_RUNS = 100;

/** Default long loop iteration count */
export const LONG_LOOP_ITERATIONS = 1000;

/** Heartbeat max age before marking as stuck (milliseconds) */
export const EXPERIMENT_HEARTBEAT_TIMEOUT_MS = 30000;

// ============================================================================
// STORAGE CONSTANTS
// ============================================================================

/** Storage version for localStorage key prefix */
export const STORAGE_VERSION = 'clean-v13-final';

/** Storage prefix for demo world */
export const DEMO_STORAGE_PREFIX = 'streaming-wfc-demo:';

/** Storage prefix for production world */
export const PROD_STORAGE_PREFIX = 'streaming-wfc:';

// ============================================================================
// DIRECTIONAL CONSTANTS
// ============================================================================

/** Direction vectors for WFC propagation (right, down, left, up) */
export const DX = [1, 0, -1, 0];
export const DY = [0, 1, 0, -1];

/** Opposite directions (for reverse propagation) */
export const OPPOSITE = [2, 3, 0, 1];

/** Direction names */
export const DIRECTIONS = ['right', 'down', 'left', 'up'];

// ============================================================================
// COLOR CONSTANTS
// ============================================================================

/** Color map for tile types when image not available */
export const TILE_COLORS = {
  water: '#3fa7f0',
  road: '#d9be7c',
  cliff: '#70411f',
  grass: '#65b93c',
};

/** Default background color for canvas */
export const CANVAS_BG_COLOR = '#07111d';

/** Selection box stroke color */
export const SELECTION_COLOR = '#ffffff';

// ============================================================================
// VALIDATION CONSTANTS
// ============================================================================

/** Input value ranges for validation */
export const INPUT_RANGES = {
  chunkSize: { min: 1, max: 100 },
  viewportWidth: { min: 1, max: 100 },
  viewportHeight: { min: 1, max: 100 },
  cacheLimit: { min: 1, max: 1000 },
  worldSeed: { min: 0, max: 999999999 },
};

// ============================================================================
// HASH & ENTROPY CONSTANTS
// ============================================================================

/** FNV-1a 32-bit offset basis for hashing */
export const FNV_OFFSET_BASIS = 2166136261 >>> 0;

/** FNV-1a 32-bit prime for hashing */
export const FNV_PRIME = 16777619;

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get adaptive policy values based on chunk size and viewport
 * @param {number} chunkSize - Size of chunks
 * @param {number} maxViewport - Maximum of viewport width/height
 * @param {boolean} demoMode - Whether in demo mode
 * @param {number} cacheLimit - Cache limit in chunks
 * @returns {Object} Adaptive policy with frontierDistance, memoryChunkLimit, etc.
 */
export function getAdaptivePolicy(chunkSize, maxViewport, demoMode, cacheLimit) {
  const halfViewport = Math.ceil(maxViewport / 2);
  const isSmall = chunkSize <= CHUNK_SIZE_THRESHOLDS.small;
  const isMedium = chunkSize <= CHUNK_SIZE_THRESHOLDS.medium;

  return {
    frontierDistance: Math.max(isSmall ? 3 : isMedium ? 3 : MIN_FRONTIER_DISTANCE, halfViewport + (isSmall || isMedium ? 1 : 0)),
    memoryKeepRadius: isSmall ? MEMORY_KEEP_RADIUS.small : MEMORY_KEEP_RADIUS.medium,
    memoryChunkLimit: Math.min(cacheLimit, isSmall ? MEMORY_CHUNK_LIMITS.small : isMedium ? MEMORY_CHUNK_LIMITS.medium : MEMORY_CHUNK_LIMITS.large),
    solvePreviewMs: demoMode ? DEMO_SOLVE_PREVIEW_MS : (isSmall ? PROD_SOLVE_PREVIEW_MS : 70),
    revealDurationMs: demoMode ? DEMO_REVEAL_DURATION_MS : (isSmall ? PROD_REVEAL_DURATION_MS : (isMedium ? RESTART_SOLVE_MS : 120)),
  };
}
