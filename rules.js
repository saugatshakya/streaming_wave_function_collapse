function parseAttributes(raw) {
  const attrs = {};
  raw.replace(/([a-zA-Z_]+)="([^"]*)"/g, (_, key, value) => {
    attrs[key] = value;
    return '';
  });
  return attrs;
}

function parseSummerXml(xmlText) {
  const setMatch = xmlText.match(/<set\s+([^>]+)>/i);
  const setAttrs = setMatch ? parseAttributes(setMatch[1]) : {};
  const unique = setAttrs.unique === 'True';

  const tiles = [];
  const tileRe = /<tile\s+([^>]+?)\s*\/?>/gi;
  let m;
  while ((m = tileRe.exec(xmlText))) tiles.push(parseAttributes(m[1]));

  const neighbors = [];
  const neighborRe = /<neighbor\s+([^>]+?)\s*\/?>/gi;
  while ((m = neighborRe.exec(xmlText))) neighbors.push(parseAttributes(m[1]));

  return { unique, tiles, neighbors };
}

function buildPropagator(T, dense) {
  const propagator = [];
  for (let d = 0; d < 4; d++) {
    propagator[d] = [];
    for (let t1 = 0; t1 < T; t1++) {
      const list = [];
      for (let t2 = 0; t2 < T; t2++) if (dense[d][t1][t2]) list.push(t2);
      propagator[d][t1] = list;
    }
  }
  return propagator;
}

async function loadImageMaybe(src) {
  if (typeof Image === 'undefined') return null;
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function fetchTextWithFallback(paths) {
  for (const path of paths) {
    try {
      const res = await fetch(path);
      if (res.ok) return { text: await res.text(), path };
    } catch {}
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    const fs = await import('node:fs/promises');
    const { resolve } = await import('node:path');
    for (const path of paths) {
      const localPath = path.startsWith('./') ? resolve(process.cwd(), path.slice(2)) : resolve(process.cwd(), path);
      try {
        return { text: await fs.readFile(localPath, 'utf8'), path };
      } catch {}
    }
  }
  throw new Error(`Unable to load XML from any of: ${paths.join(', ')}`);
}

export async function loadSummerRules() {
  const { text: xmlText, path: xmlPath } = await fetchTextWithFallback(['./tiles/Summer.xml', './Summer.xml']);
  const parsed = parseSummerXml(xmlText);
  const tileBaseDir = xmlPath.startsWith('./tiles/') ? './tiles/' : './';

  const action = [];
  const firstOccurrence = {};
  const tileVariants = [];
  const weights = [];

  for (const tileNode of parsed.tiles) {
    const name = tileNode.name;
    const sym = tileNode.symmetry || 'X';
    const weight = parseFloat(tileNode.weight || '1');
    let a, b, cardinality;

    switch (sym) {
      case 'L':
        cardinality = 4;
        a = i => (i + 1) % 4;
        b = i => (i % 2 === 0 ? i + 1 : i - 1);
        break;
      case 'T':
        cardinality = 4;
        a = i => (i + 1) % 4;
        b = i => (i % 2 === 0 ? i : 4 - i);
        break;
      case 'I':
        cardinality = 2;
        a = i => 1 - i;
        b = i => i;
        break;
      case '\\':
        cardinality = 2;
        a = i => 1 - i;
        b = i => 1 - i;
        break;
      case 'F':
        cardinality = 8;
        a = i => i < 4 ? (i + 1) % 4 : 4 + ((i - 1 + 4) % 4);
        b = i => i < 4 ? i + 4 : i - 4;
        break;
      default:
        cardinality = 1;
        a = i => i;
        b = i => i;
        break;
    }

    const base = action.length;
    firstOccurrence[name] = base;

    for (let t = 0; t < cardinality; t++) {
      const map = new Array(8);
      map[0] = t;
      map[1] = a(t);
      map[2] = a(a(t));
      map[3] = a(a(a(t)));
      map[4] = b(t);
      map[5] = b(a(t));
      map[6] = b(a(a(t)));
      map[7] = b(a(a(a(t))));
      for (let s = 0; s < 8; s++) map[s] += base;
      action.push(map);
      tileVariants.push({ name, orientation: t, image: null });
      weights.push(weight);
    }
  }

  const T = action.length;
  const dense = Array.from({ length: 4 }, () => Array.from({ length: T }, () => new Array(T).fill(false)));

  function setH(lo, ro) {
    dense[0][lo][ro] = true;
    dense[2][ro][lo] = true;
  }
  function setV(up, down) {
    dense[1][up][down] = true;
    dense[3][down][up] = true;
  }

  for (const n of parsed.neighbors) {
    const leftParts = n.left.trim().split(/\s+/);
    const rightParts = n.right.trim().split(/\s+/);
    const lname = leftParts[0];
    const rname = rightParts[0];
    if (!(lname in firstOccurrence) || !(rname in firstOccurrence)) continue;
    const lo = leftParts.length > 1 ? parseInt(leftParts[1], 10) : 0;
    const ro = rightParts.length > 1 ? parseInt(rightParts[1], 10) : 0;
    const L = action[firstOccurrence[lname]][lo];
    const R = action[firstOccurrence[rname]][ro];
    const D = action[L][1];
    const U = action[R][1];
    setH(L, R);
    setH(action[L][6], action[R][6]);
    setH(action[R][4], action[L][4]);
    setH(action[R][2], action[L][2]);
    setV(U, D);
    setV(action[D][6], action[U][6]);
    setV(action[U][4], action[D][4]);
    setV(action[D][2], action[U][2]);
  }

  const propagator = buildPropagator(T, dense);
  const fullMask = (1n << BigInt(T)) - 1n;

  let loadedImageCount = 0;
  await Promise.all(tileVariants.map(async tile => {
    const paths = [
      `${tileBaseDir}${tile.name} ${tile.orientation}.png`,
      `./tiles/${tile.name} ${tile.orientation}.png`,
      `./${tile.name} ${tile.orientation}.png`,
    ];
    for (const path of paths) {
      const img = await loadImageMaybe(path);
      if (img) {
        tile.image = img;
        loadedImageCount += 1;
        break;
      }
    }
  }));

  const previewRows = [
    ['grass 0', 'grass 0', 'road 0', 'grass 0', 'grass 0', 'grass 0', 'water_a 0', 'water_a 0', 'water_a 0'],
    ['grass 0', 'grass 0', 'road 0', 'grass 0', 'road 0', 'roadturn 1', 'waterside 0', 'water_b 0', 'water_a 0'],
    ['grass 0', 'grass 0', 'road 0', 'roadturn 1', 'road 0', 'grass 0', 'waterside 0', 'water_c 0', 'water_a 0'],
    ['waterside 3', 'water_a 0', 'road 0', 'grass 0', 'grass 0', 'grass 0', 'waterside 0', 'waterturn 3', 'grass 0'],
  ];

  return {
    xmlText,
    tileBaseDir,
    unique: parsed.unique,
    tileCount: T,
    tiles: tileVariants,
    weights,
    propagator,
    fullMask,
    loadedImageCount,
    previewRows,
  };
}
