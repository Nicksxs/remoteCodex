const VERSIONS_L = [
  null,
  { dataCodewords: 19, eccCodewords: 7 },
  { dataCodewords: 34, eccCodewords: 10 },
  { dataCodewords: 55, eccCodewords: 15 },
  { dataCodewords: 80, eccCodewords: 20 },
  { dataCodewords: 108, eccCodewords: 26 },
];

export function encodeQr(text, { mask: forcedMask = null } = {}) {
  const bytes = Buffer.from(text, "utf8");
  const version = chooseVersion(bytes.length);
  const config = VERSIONS_L[version];
  const data = makeDataCodewords(bytes, config.dataCodewords);
  const divisor = reedSolomonDivisor(config.eccCodewords);
  const ecc = reedSolomonRemainder(data, divisor);
  const codewords = Uint8Array.from([...data, ...ecc]);
  const base = makeFunctionPatterns(version);

  let best = null;
  let bestPenalty = Number.POSITIVE_INFINITY;
  const masks = forcedMask == null ? [0, 1, 2, 3, 4, 5, 6, 7] : [forcedMask];
  for (const mask of masks) {
    if (!Number.isInteger(mask) || mask < 0 || mask > 7) throw new Error("Invalid QR mask");
    const candidate = cloneMatrix(base);
    drawCodewords(candidate, codewords, mask);
    drawFormatBits(candidate, mask);
    const penalty = penaltyScore(candidate.modules);
    if (penalty < bestPenalty) {
      best = candidate.modules;
      bestPenalty = penalty;
    }
  }
  return best;
}

export function terminalQr(text) {
  const matrix = encodeQr(text);
  const quiet = 4;
  let output = "";
  for (let y = -quiet; y < matrix.length + quiet; y += 2) {
    output += "\u001b[30;47m";
    for (let x = -quiet; x < matrix.length + quiet; x += 1) {
      const top = moduleAt(matrix, x, y);
      const bottom = moduleAt(matrix, x, y + 1);
      output += top ? (bottom ? "█" : "▀") : (bottom ? "▄" : " ");
    }
    output += "\u001b[0m\n";
  }
  return output;
}

function chooseVersion(byteLength) {
  for (let version = 1; version < VERSIONS_L.length; version += 1) {
    if (4 + 8 + byteLength * 8 <= VERSIONS_L[version].dataCodewords * 8) return version;
  }
  throw new Error("配对地址过长，无法生成终端二维码");
}

function makeDataCodewords(bytes, capacity) {
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacityBits = capacity * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  appendBits(bits, 0, (8 - bits.length % 8) % 8);

  const result = [];
  for (let index = 0; index < bits.length; index += 8) {
    let value = 0;
    for (let offset = 0; offset < 8; offset += 1) value = (value << 1) | bits[index + offset];
    result.push(value);
  }
  for (let pad = 0; result.length < capacity; pad += 1) result.push(pad % 2 === 0 ? 0xec : 0x11);
  return Uint8Array.from(result);
}

function appendBits(target, value, length) {
  if (length < 0) throw new Error("QR payload exceeds capacity");
  for (let bit = length - 1; bit >= 0; bit -= 1) target.push((value >>> bit) & 1);
}

function reedSolomonDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let index = 0; index < degree; index += 1) {
    for (let coefficient = 0; coefficient < degree; coefficient += 1) {
      result[coefficient] = gfMultiply(result[coefficient], root);
      if (coefficient + 1 < degree) result[coefficient] ^= result[coefficient + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let index = 0; index < result.length; index += 1) result[index] ^= gfMultiply(divisor[index], factor);
  }
  return result;
}

function gfMultiply(left, right) {
  let result = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((right >>> bit) & 1) * left;
  }
  return result & 0xff;
}

function makeFunctionPatterns(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => Array(size).fill(false));
  const functions = Array.from({ length: size }, () => Array(size).fill(false));
  const state = { modules, functions };

  for (let index = 0; index < size; index += 1) {
    setFunction(state, 6, index, index % 2 === 0);
    setFunction(state, index, 6, index % 2 === 0);
  }
  drawFinder(state, 3, 3);
  drawFinder(state, size - 4, 3);
  drawFinder(state, 3, size - 4);
  if (version > 1) drawAlignment(state, size - 7, size - 7);
  drawFormatBits(state, 0);
  return state;
}

function drawFinder(state, centerX, centerY) {
  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunction(state, centerX + x, centerY + y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(state, centerX, centerY) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) setFunction(state, centerX + x, centerY + y, Math.max(Math.abs(x), Math.abs(y)) !== 1);
  }
}

function drawFormatBits(state, mask) {
  const data = (1 << 3) | mask; // Error correction level L.
  let remainder = data;
  for (let index = 0; index < 10; index += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const size = state.modules.length;
  const bit = (index) => ((bits >>> index) & 1) !== 0;

  for (let index = 0; index <= 5; index += 1) setFunction(state, 8, index, bit(index));
  setFunction(state, 8, 7, bit(6));
  setFunction(state, 8, 8, bit(7));
  setFunction(state, 7, 8, bit(8));
  for (let index = 9; index < 15; index += 1) setFunction(state, 14 - index, 8, bit(index));
  for (let index = 0; index < 8; index += 1) setFunction(state, size - 1 - index, 8, bit(index));
  for (let index = 8; index < 15; index += 1) setFunction(state, 8, size - 15 + index, bit(index));
  setFunction(state, 8, size - 8, true);
}

function drawCodewords(state, codewords, mask) {
  const size = state.modules.length;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    const upward = ((right + 1) & 2) === 0;
    for (let vertical = 0; vertical < size; vertical += 1) {
      const y = upward ? size - 1 - vertical : vertical;
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        if (state.functions[y][x]) continue;
        let value = false;
        if (bitIndex < codewords.length * 8) value = ((codewords[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
        state.modules[y][x] = value !== maskBit(mask, x, y);
        bitIndex += 1;
      }
    }
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new Error("Invalid QR mask");
  }
}

function penaltyScore(modules) {
  const size = modules.length;
  let penalty = 0;
  for (let y = 0; y < size; y += 1) penalty += linePenalty(modules[y]);
  for (let x = 0; x < size; x += 1) penalty += linePenalty(modules.map((row) => row[x]));

  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const value = modules[y][x];
      if (modules[y][x + 1] === value && modules[y + 1][x] === value && modules[y + 1][x + 1] === value) penalty += 3;
    }
  }

  let black = 0;
  for (const row of modules) for (const value of row) if (value) black += 1;
  penalty += Math.floor(Math.abs(black * 20 - size * size * 10) / (size * size)) * 10;
  return penalty;
}

function linePenalty(line) {
  let penalty = 0;
  let run = 1;
  for (let index = 1; index <= line.length; index += 1) {
    if (index < line.length && line[index] === line[index - 1]) run += 1;
    else {
      if (run >= 5) penalty += 3 + run - 5;
      run = 1;
    }
  }
  const text = line.map((value) => value ? "1" : "0").join("");
  for (let index = 0; index <= text.length - 11; index += 1) {
    const pattern = text.slice(index, index + 11);
    if (pattern === "00001011101" || pattern === "10111010000") penalty += 40;
  }
  return penalty;
}

function setFunction(state, x, y, value) {
  if (y < 0 || y >= state.modules.length || x < 0 || x >= state.modules.length) return;
  state.modules[y][x] = value;
  state.functions[y][x] = true;
}

function cloneMatrix(state) {
  return {
    modules: state.modules.map((row) => [...row]),
    functions: state.functions.map((row) => [...row]),
  };
}

function moduleAt(matrix, x, y) {
  return y >= 0 && y < matrix.length && x >= 0 && x < matrix.length ? matrix[y][x] : false;
}
