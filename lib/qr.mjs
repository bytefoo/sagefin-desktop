// @ts-check
// A QR code, made here: the enrolment code a phone scans to add this computer.
//
// Written out rather than taken from a package, because this app installs nothing it runs, and a
// QR code is a few hundred lines of public arithmetic (ISO/IEC 18004). It covers exactly what the
// app draws: alphanumeric or byte data, error correction level M, versions 1 to 10. It encodes and
// never decodes, reads nothing and fetches nothing; what it encodes is a string this app made.
//
// The mask is chosen as the widely used qrcode-generator chooses it, so that the tests can hold
// every module of the result to that library's output for the same text (lib/qr.test.mjs).

/** The characters alphanumeric mode carries, in their order. */
const ALPHANUMERIC = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

// Level M, versions 1 to 10: error correction codewords per block, and the number of blocks.
const ECC_PER_BLOCK = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const MAX_VERSION = 10;

/** @param {number} version */
function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** @param {number} version */
const dataCodewords = (version) => Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];

/** @param {number} version */
function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = version * 4 + 10; result.length < count; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** GF(256) multiplication, modulo x^8 + x^4 + x^3 + x^2 + 1. */
function multiply(/** @type {number} */ x, /** @type {number} */ y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** @param {number} degree */
function divisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = multiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = multiply(root, 0x02);
  }
  return result;
}

/** @param {number[]} data @param {number[]} by */
function remainder(data, by) {
  const result = new Array(by.length).fill(0);
  for (const b of data) {
    const factor = b ^ /** @type {number} */ (result.shift());
    result.push(0);
    by.forEach((coefficient, i) => (result[i] ^= multiply(coefficient, factor)));
  }
  return result;
}

/** @param {string} text */
const isAlphanumeric = (text) => [...text].every((c) => ALPHANUMERIC.includes(c));

/**
 * The data's bits: mode, count, the characters, the terminator and padding, as codewords.
 * @param {string} text @param {number} version
 */
function dataCodewordsOf(text, version) {
  /** @type {number[]} */
  const bits = [];
  const put = (/** @type {number} */ value, /** @type {number} */ length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  if (isAlphanumeric(text)) {
    put(0b0010, 4);
    put(text.length, version <= 9 ? 9 : 11);
    for (let i = 0; i + 1 < text.length; i += 2) put(ALPHANUMERIC.indexOf(text[i]) * 45 + ALPHANUMERIC.indexOf(text[i + 1]), 11);
    if (text.length % 2 === 1) put(ALPHANUMERIC.indexOf(text[text.length - 1]), 6);
  } else {
    const bytes = new TextEncoder().encode(text);
    put(0b0100, 4);
    put(bytes.length, version <= 9 ? 8 : 16);
    for (const b of bytes) put(b, 8);
  }
  const capacity = dataCodewords(version) * 8;
  if (bits.length > capacity) return null;
  put(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; codewords.length < capacity / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** @param {number[]} data @param {number} version */
function withErrorCorrection(data, version) {
  const blocks = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLength = Math.floor(raw / blocks);
  const by = divisor(eccLength);
  /** @type {number[][]} */
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = remainder(block, by);
    if (i < shortBlocks) block.push(0);
    all.push(block.concat(ecc));
  }
  /** @type {number[]} */
  const result = [];
  for (let i = 0; i < all[0].length; i++) {
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

/** @type {((x: number, y: number) => boolean)[]} */
const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * The code for [mask], every module, `true` dark. With `trial` the format and version bits and the
 * dark module are left light: the matrix a mask is scored on, as qrcode-generator scores it.
 * @param {number[]} codewords @param {number} version @param {number} mask @param {boolean} trial
 */
function draw(codewords, version, mask, trial) {
  const size = version * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ on) => {
    dark[y][x] = on;
    fixed[y][x] = true;
  };

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(x, y, d !== 2 && d !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  positions.forEach((px, i) =>
    positions.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }),
  );

  // Format bits: level M (00) and the mask, BCH(15,5), XOR 0x5412.
  const formatData = (0b00 << 3) | mask;
  let r = formatData;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  const format = ((formatData << 10) | r) ^ 0x5412;
  const fbit = (/** @type {number} */ i) => !trial && ((format >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) set(8, i, fbit(i));
  set(8, 7, fbit(6));
  set(8, 8, fbit(7));
  set(7, 8, fbit(8));
  for (let i = 9; i < 15; i++) set(14 - i, 8, fbit(i));
  for (let i = 0; i < 8; i++) set(size - 1 - i, 8, fbit(i));
  for (let i = 8; i < 15; i++) set(8, size - 15 + i, fbit(i));
  set(8, size - 8, !trial);

  if (version >= 7) {
    let v = version;
    for (let i = 0; i < 12; i++) v = (v << 1) ^ ((v >>> 11) * 0x1f25);
    const bits = (version << 12) | v;
    for (let i = 0; i < 18; i++) {
      const on = !trial && ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, on);
      set(b, a, on);
    }
  }

  const masked = MASKS[mask];
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (fixed[y][x]) continue;
        let on = false;
        if (i < codewords.length * 8) on = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
        i++;
        dark[y][x] = on !== masked(x, y);
      }
    }
  }
  return dark;
}

/** How bad a mask looks, as qrcode-generator scores it ("lost points"). @param {boolean[][]} m */
function lostPoints(m) {
  const n = m.length;
  let lost = 0;
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      let same = 0;
      for (let r = -1; r <= 1; r++) {
        if (row + r < 0 || row + r >= n) continue;
        for (let c = -1; c <= 1; c++) {
          if (col + c < 0 || col + c >= n || (r === 0 && c === 0)) continue;
          if (m[row][col] === m[row + r][col + c]) same++;
        }
      }
      if (same > 5) lost += 3 + same - 5;
    }
  }
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n - 1; col++) {
      const count = +m[row][col] + +m[row + 1][col] + +m[row][col + 1] + +m[row + 1][col + 1];
      if (count === 0 || count === 4) lost += 3;
    }
  }
  const finderLike = (/** @type {(k: number) => boolean} */ at) => at(0) && !at(1) && at(2) && at(3) && at(4) && !at(5) && at(6);
  for (let row = 0; row < n; row++) for (let col = 0; col < n - 6; col++) if (finderLike((k) => m[row][col + k])) lost += 40;
  for (let col = 0; col < n; col++) for (let row = 0; row < n - 6; row++) if (finderLike((k) => m[row + k][col])) lost += 40;
  let darkCount = 0;
  for (const row of m) for (const on of row) if (on) darkCount++;
  lost += (Math.abs((100 * darkCount) / n / n - 50) / 5) * 10;
  return lost;
}

/**
 * The QR code for [text], at level M in the smallest version that holds it, as rows of `true`
 * (dark) and `false`. Null when it does not fit in version 10.
 * @param {string} text
 * @returns {boolean[][] | null}
 */
export function qrModules(text) {
  for (let version = 1; version <= MAX_VERSION; version++) {
    const data = dataCodewordsOf(text, version);
    if (!data) continue;
    const codewords = withErrorCorrection(data, version);
    let best = 0;
    let bestLost = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const lost = lostPoints(draw(codewords, version, mask, true));
      if (lost < bestLost) {
        bestLost = lost;
        best = mask;
      }
    }
    return draw(codewords, version, best, false);
  }
  return null;
}

/**
 * The same as rows of `1` and `0`: what crosses to the window that draws it, which needs nothing
 * else and can be shown nothing else.
 * @param {string} text
 */
export const qrRows = (text) => qrModules(text)?.map((row) => row.map((on) => (on ? "1" : "0")).join("")) ?? null;
