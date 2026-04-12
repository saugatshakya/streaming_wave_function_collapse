export function mulberry32(seed) {
  let t = seed >>> 0;
  return function random() {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashCoords(seed, x, y, salt = 0) {
  let h = (seed ^ 0x9e3779b9 ^ salt) >>> 0;
  h = Math.imul(h ^ (x + 0x7f4a7c15), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (y + 0x165667b1), 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function shuffleInPlace(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
