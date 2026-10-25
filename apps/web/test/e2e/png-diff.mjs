/**
 * Минимальный PNG-декодер и попиксельное сравнение для E2E-скриншотов.
 *
 * Playwright отдаёт скриншоты как PNG (RGBA, 8 бит, без чересстрочности).
 * Декодер поддерживает colorType 0/2/3/6 при bitDepth 8 и filter 0–4
 * (стандартный набор PNG). Сравнение считает долю отличающихся пикселей:
 * пиксель отличается, если максимум разности по каналам RGB превышает
 * threshold (по умолчанию 51/255 ≈ 0.2 — согласовано с Playwright).
 */

import { inflateSync } from "node:zlib";

export const DEFAULT_PIXEL_THRESHOLD = 51;

function readUInt32BE(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

/**
 * Декодирует PNG-буфер в { width, height, data: Uint8Array } где data —
 * RGBA-пиксели (width*height*4).
 */
export function decodePng(buffer) {
  if (buffer.length < 33 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
    throw new Error("PNG signature mismatch");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks = [];
  let sawIhdr = false;
  let sawIend = false;
  while (offset + 8 <= buffer.length && !sawIend) {
    const length = readUInt32BE(buffer, offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("Truncated PNG chunk");
    if (type === "IHDR") {
      if (sawIhdr || length !== 13) throw new Error("Invalid IHDR");
      width = readUInt32BE(buffer, dataStart);
      height = readUInt32BE(buffer, dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
      const compression = buffer[dataStart + 10];
      const filterMethod = buffer[dataStart + 11];
      interlace = buffer[dataStart + 12];
      if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth ${bitDepth}`);
      if (compression !== 0 || filterMethod !== 0) throw new Error("Unsupported PNG compression/filter method");
      if (interlace !== 0) throw new Error("Interlaced PNG is not supported");
      if (![0, 2, 3, 6].includes(colorType)) throw new Error(`Unsupported PNG color type ${colorType}`);
      sawIhdr = true;
    } else if (type === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      sawIend = true;
    }
    offset = dataEnd + 4;
  }
  if (!sawIhdr || idatChunks.length === 0) throw new Error("PNG missing IHDR/IDAT");

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const bytesPerRow = width * bpp;
  const inflated = inflateSync(Buffer.concat(idatChunks));
  const expected = (bytesPerRow + 1) * height;
  if (inflated.length !== expected) {
    throw new Error(`PNG scanline buffer mismatch: expected ${expected}, got ${inflated.length}`);
  }

  const data = new Uint8Array(width * height * 4);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
  };

  const prev = new Uint8Array(bytesPerRow);
  const current = new Uint8Array(bytesPerRow);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (bytesPerRow + 1)];
    const rowStart = y * (bytesPerRow + 1) + 1;
    for (let x = 0; x < bytesPerRow; x += 1) {
      const raw = inflated[rowStart + x];
      const a = x >= bpp ? current[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let value;
      switch (filter) {
        case 0: value = raw; break;
        case 1: value = (raw + a) & 0xff; break;
        case 2: value = (raw + b) & 0xff; break;
        case 3: value = (raw + ((a + b) >> 1)) & 0xff; break;
        case 4: value = (raw + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`Unknown PNG filter ${filter}`);
      }
      current[x] = value;
    }
    for (let x = 0; x < bytesPerRow; x += 1) {
      const outIndex = (y * width * 4) + (x * 4);
      if (colorType === 6) {
        data[outIndex] = current[x];
        data[outIndex + 1] = current[x + 1];
        data[outIndex + 2] = current[x + 2];
        data[outIndex + 3] = current[x + 3];
      } else if (colorType === 2) {
        data[outIndex] = current[x];
        data[outIndex + 1] = current[x + 1];
        data[outIndex + 2] = current[x + 2];
        data[outIndex + 3] = 255;
      } else if (colorType === 0) {
        data[outIndex] = current[x];
        data[outIndex + 1] = current[x];
        data[outIndex + 2] = current[x];
        data[outIndex + 3] = 255;
      } else {
        // colorType 3 (палитра): без PLTE-разбора — grayscale-замена как fallback.
        data[outIndex] = current[x];
        data[outIndex + 1] = current[x];
        data[outIndex + 2] = current[x];
        data[outIndex + 3] = 255;
      }
    }
    prev.set(current);
    current.fill(0);
  }

  return { width, height, data };
}

/**
 * Возвращает { ratio, diffPixels, totalPixels, width, height }.
 * Доли считаются по числу отличающихся пикселей. Изображения разных
 * размеров сравниваются по общей площади min(width)*min(height);
 * несравненные пиксели считаются отличающимися.
 */
export function diffPng(a, b, { threshold = DEFAULT_PIXEL_THRESHOLD } = {}) {
  const left = decodePng(a);
  const right = decodePng(b);
  const width = Math.min(left.width, right.width);
  const height = Math.min(left.height, right.height);
  const totalPixels = width * height;
  const maxPixels = Math.max(left.width * left.height, right.width * right.height);
  let diffPixels = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const li = (y * left.width * 4) + (x * 4);
      const ri = (y * right.width * 4) + (x * 4);
      const dR = Math.abs(left.data[li] - right.data[ri]);
      const dG = Math.abs(left.data[li + 1] - right.data[ri + 1]);
      const dB = Math.abs(left.data[li + 2] - right.data[ri + 2]);
      if (dR > threshold || dG > threshold || dB > threshold) diffPixels += 1;
    }
  }
  const total = Math.max(totalPixels, maxPixels);
  return { ratio: diffPixels / total, diffPixels, totalPixels: total, width, height };
}
