/**
 * A small QR encoder: byte mode, error correction level M, following ISO/IEC 18004.
 * Enough for an otpauth URI, which is why it stops at version 20 (666 bytes at level M).
 */

const eccPerBlock = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26];
const blocksPerVersion = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16];
const maxVersion = 20;

const eccLevelBits = 0; // Level M

function rawModules(version: number): number {
  let count = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignCount = Math.floor(version / 7) + 2;
    count -= (25 * alignCount - 10) * alignCount - 55;
    if (version >= 7) {
      count -= 36;
    }
  }
  return count;
}

function dataCapacity(version: number): number {
  return Math.floor(rawModules(version) / 8) - (eccPerBlock[version] ?? 0) * (blocksPerVersion[version] ?? 0);
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= maxVersion; version++) {
    const lengthBits = version < 10 ? 8 : 16;
    if (4 + lengthBits + byteLength * 8 <= dataCapacity(version) * 8) {
      return version;
    }
  }
  throw new RangeError("Value is too long for a QR code");
}

function gfMultiply(a: number, b: number): number {
  let result = 0;
  let x = a;
  for (let bit = b; bit > 0; bit >>= 1) {
    if (bit & 1) {
      result ^= x;
    }
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  return result;
}

function generatorPolynomial(degree: number): number[] {
  const coefficients = new Array<number>(degree).fill(0);
  coefficients[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      coefficients[j] = gfMultiply(coefficients[j] ?? 0, root) ^ (coefficients[j + 1] ?? 0);
    }
    root = gfMultiply(root, 2);
  }
  return coefficients;
}

function eccBytes(data: readonly number[], generator: readonly number[]): number[] {
  const remainder = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder.shift() ?? 0);
    remainder.push(0);
    generator.forEach((coefficient, index) => {
      remainder[index] = (remainder[index] ?? 0) ^ gfMultiply(coefficient, factor);
    });
  }
  return remainder;
}

function dataStream(bytes: Uint8Array, version: number): number[] {
  const capacity = dataCapacity(version);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) {
      bits.push((value >> i) & 1);
    }
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) {
    push(byte, 8);
  }
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);

  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | (bit ?? 0), 0));
  }
  for (let pad = 0xec; codewords.length < capacity; pad ^= 0xec ^ 0x11) {
    codewords.push(pad);
  }
  return codewords;
}

/** Splits into blocks, adds Reed-Solomon codewords and interleaves, as the symbol expects. */
function interleave(data: readonly number[], version: number): number[] {
  const blockCount = blocksPerVersion[version] ?? 1;
  const eccLength = eccPerBlock[version] ?? 0;
  const total = Math.floor(rawModules(version) / 8);
  const shortBlocks = blockCount - (total % blockCount);
  const shortLength = Math.floor(total / blockCount) - eccLength;
  const generator = generatorPolynomial(eccLength);

  const dataBlocks: number[][] = [];
  const eccBlocks: number[][] = [];
  let offset = 0;
  for (let i = 0; i < blockCount; i++) {
    const length = shortLength + (i < shortBlocks ? 0 : 1);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(eccBytes(block, generator));
  }

  const result: number[] = [];
  for (let column = 0; column <= shortLength; column++) {
    for (const block of dataBlocks) {
      const byte = block[column];
      if (byte !== undefined) {
        result.push(byte);
      }
    }
  }
  for (let column = 0; column < eccLength; column++) {
    for (const block of eccBlocks) {
      result.push(block[column] ?? 0);
    }
  }
  return result;
}

function alignmentPositions(version: number, size: number): number[] {
  if (version === 1) {
    return [];
  }
  const count = Math.floor(version / 7) + 2;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let position = size - 7; positions.length < count; position -= step) {
    positions.splice(1, 0, position);
  }
  return positions;
}

function bch(data: number, polynomial: number, dataBits: number, totalBits: number): number {
  const eccBits = totalBits - dataBits;
  let remainder = data << eccBits;
  for (let i = totalBits - 1; i >= eccBits; i--) {
    if ((remainder >> i) & 1) {
      remainder ^= polynomial << (i - eccBits);
    }
  }
  return (data << eccBits) | remainder;
}

const masks: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

type Grid = boolean[][];

function emptyGrid(size: number): Grid {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function cell(grid: Grid, x: number, y: number): boolean {
  return grid[y]?.[x] ?? false;
}

function setCell(grid: Grid, x: number, y: number, value: boolean): void {
  const row = grid[y];
  if (row && x >= 0 && x < row.length) {
    row[x] = value;
  }
}

function drawFunctionPatterns(modules: Grid, reserved: Grid, version: number): void {
  const size = modules.length;
  const draw = (x: number, y: number, dark: boolean) => {
    setCell(modules, x, y, dark);
    setCell(reserved, x, y, true);
  };

  for (let i = 0; i < size; i++) {
    if (i < 9 || i >= size - 8) {
      continue;
    }
    draw(6, i, i % 2 === 0);
    draw(i, 6, i % 2 === 0);
  }

  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          draw(x, y, distance !== 2 && distance !== 4);
        }
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  positions.forEach((cy, row) => {
    positions.forEach((cx, column) => {
      if ((row === 0 && column === 0) || (row === 0 && column === last) || (row === last && column === 0)) {
        return;
      }
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          draw(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    });
  });

  // Reserve the format areas. Their real bits go in once the mask is chosen.
  for (let i = 0; i <= 8; i++) {
    setCell(reserved, 8, i, true);
    setCell(reserved, i, 8, true);
  }
  for (let i = 0; i < 8; i++) {
    setCell(reserved, size - 1 - i, 8, true);
    setCell(reserved, 8, size - 1 - i, true);
  }
  draw(8, size - 8, true);

  if (version >= 7) {
    const bits = bch(version, 0x1f25, 6, 18);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      draw(a, b, dark);
      draw(b, a, dark);
    }
  }
}

function placeCodewords(modules: Grid, reserved: Grid, codewords: readonly number[]): void {
  const size = modules.length;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) {
      right = 5;
    }
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (const x of [right, right - 1]) {
        if (cell(reserved, x, y)) {
          continue;
        }
        const byte = codewords[bitIndex >> 3] ?? 0;
        setCell(modules, x, y, ((byte >> (7 - (bitIndex & 7))) & 1) === 1);
        bitIndex++;
      }
    }
    upward = !upward;
  }
}

function withMask(modules: Grid, reserved: Grid, mask: number): Grid {
  const pattern = masks[mask];
  return modules.map((row, y) =>
    row.map((dark, x) => (!cell(reserved, x, y) && pattern?.(x, y) ? !dark : dark)),
  );
}

function drawFormatBits(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = bch((eccLevelBits << 3) | mask, 0x537, 5, 15) ^ 0x5412;
  const bit = (i: number) => ((bits >> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) {
    setCell(grid, 8, i, bit(i));
  }
  setCell(grid, 8, 7, bit(6));
  setCell(grid, 8, 8, bit(7));
  setCell(grid, 7, 8, bit(8));
  for (let i = 9; i < 15; i++) {
    setCell(grid, 14 - i, 8, bit(i));
  }
  for (let i = 0; i < 8; i++) {
    setCell(grid, size - 1 - i, 8, bit(i));
  }
  for (let i = 8; i < 15; i++) {
    setCell(grid, 8, size - 15 + i, bit(i));
  }
}

function penalty(grid: Grid): number {
  const size = grid.length;
  let score = 0;
  let dark = 0;

  const scanLine = (at: (i: number) => boolean) => {
    let run = 1;
    let window = at(0) ? 1 : 0;
    for (let i = 1; i < size; i++) {
      const current = at(i);
      if (current === at(i - 1)) {
        run++;
      } else {
        run = 1;
      }
      if (run === 5) {
        score += 3;
      } else if (run > 5) {
        score += 1;
      }
      window = ((window << 1) & 0x7ff) | (current ? 1 : 0);
      if (i >= 10 && (window === 0b10111010000 || window === 0b00001011101)) {
        score += 40;
      }
    }
  };

  for (let i = 0; i < size; i++) {
    scanLine((j) => cell(grid, j, i));
    scanLine((j) => cell(grid, i, j));
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const value = cell(grid, x, y);
      if (value) {
        dark++;
      }
      if (
        x < size - 1 &&
        y < size - 1 &&
        value === cell(grid, x + 1, y) &&
        value === cell(grid, x, y + 1) &&
        value === cell(grid, x + 1, y + 1)
      ) {
        score += 3;
      }
    }
  }

  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** Encodes text as a square matrix of modules. `true` is a dark module. */
export function encodeQr(text: string): boolean[][] {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const size = version * 4 + 17;
  const modules = emptyGrid(size);
  const reserved = emptyGrid(size);

  drawFunctionPatterns(modules, reserved, version);
  placeCodewords(modules, reserved, interleave(dataStream(bytes, version), version));

  let best: Grid = modules;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < masks.length; mask++) {
    const candidate = withMask(modules, reserved, mask);
    drawFormatBits(candidate, mask);
    const score = penalty(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
