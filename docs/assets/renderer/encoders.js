import { quantize } from './palette.js';

const text = (s) => new TextEncoder().encode(s);
const short = (v) => [v & 255, v >> 8 & 255];
export const frameShare = (i, count, total) => Math.round((i + 1) * total / count) - Math.round(i * total / count);

function lzw(indices) {
  const chunks = [new Uint8Array([8])];
  let block = [], bits = 0, bitCount = 0, codeSize = 9, next = 258;
  const codes = new Map();
  const byte = (value) => {
    block.push(value & 255);
    if (block.length === 255) { chunks.push(new Uint8Array([255, ...block])); block = []; }
  };
  const emit = (code) => {
    bits |= code << bitCount; bitCount += codeSize;
    while (bitCount >= 8) { byte(bits); bits >>>= 8; bitCount -= 8; }
  };
  emit(256);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i], key = prefix << 8 | k;
    if (codes.has(key)) { prefix = codes.get(key); continue; }
    emit(prefix);
    if (next === 4096) { emit(256); codes.clear(); next = 258; codeSize = 9; }
    else { if (next >= 1 << codeSize) codeSize++; codes.set(key, next++); }
    prefix = k;
  }
  emit(prefix); emit(257);
  if (bitCount) byte(bits);
  if (block.length) chunks.push(new Uint8Array([block.length, ...block]));
  chunks.push(new Uint8Array([0]));
  return new Blob(chunks);
}

function chunk(type, data) {
  const header = new Uint8Array(8);
  header.set(text(type)); new DataView(header.buffer).setUint32(4, data.size ?? data.length, true);
  return new Blob([header, data, new Uint8Array((data.size ?? data.length) % 2)]);
}

function le24(bytes, offset, value) {
  bytes[offset] = value; bytes[offset + 1] = value >> 8; bytes[offset + 2] = value >> 16;
}

export function webpFrame(bytes, width, height, delay, first = false) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP') throw new Error('Encoder did not produce WebP');
  const image = [];
  let alpha = false, found = false;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true), type = String.fromCharCode(...bytes.slice(offset, offset + 4));
    if (offset + 8 + size > bytes.length) throw new Error(`Truncated WebP chunk at ${offset}`);
    if (['ALPH', 'VP8 ', 'VP8L'].includes(type)) image.push(bytes.slice(offset, offset + 8 + size + size % 2));
    alpha ||= type === 'ALPH' || type === 'VP8L'; found ||= type === 'VP8 ' || type === 'VP8L';
    offset += 8 + size + size % 2;
  }
  if (!found) throw new Error('WebP frame has no image');
  // Skia requires an alpha-capable first frame if later frames are transparent.
  if (first && !alpha) image.unshift(chunk('ALPH', new Blob([new Uint8Array([0]), new Uint8Array(width * height).fill(255)])));
  const info = new Uint8Array(16);
  le24(info, 6, width - 1); le24(info, 9, height - 1); le24(info, 12, delay); info[15] = 2;
  return chunk('ANMF', new Blob([info, ...image]));
}

function webpHeader(width, height, plays) {
  const header = new Uint8Array(10); header[0] = 0x12;
  le24(header, 4, width - 1); le24(header, 7, height - 1);
  return [chunk('VP8X', header), chunk('ANIM', new Uint8Array([0, 0, 0, 0, ...short(plays)]))];
}

let media;
async function mediabunny() {
  return media ??= import('./vendor/mediabunny-1.65.2/dist/bundles/mediabunny.mjs');
}

export async function encodeSupport({ format, width, height, fps, quality = 80 }) {
  if (![width, height].every((n) => Number.isInteger(n) && n > 0 && n <= 3840)) throw new Error(`Invalid output size: ${width}x${height}`);
  if (format !== 'mp4') return { width, height };
  if (typeof VideoEncoder === 'undefined') throw new Error('H.264/WebCodecs unavailable in this browser');
  width += width % 2; height += height % 2;
  const m = await mediabunny();
  if (!await m.canEncodeVideo('avc', { width, height, bitrate: Math.round(width * height * fps * (0.025 + quality * 0.002)), frameRate: fps })) {
    throw new Error(`H.264/WebCodecs unavailable for ${width}x${height} at ${fps} fps`);
  }
  return { width, height };
}

export class BrowserEncoder {
  constructor(engine, fallback) { this.engine = engine; this.fallback = fallback; }

  async start(options) {
    if (this.options) throw new Error('Encoder already active');
    const { format, width, height, frameCount, durationMs, quality, plays, colors, renderWidth, renderHeight } = options;
    if (!['gif', 'mp4', 'webp'].includes(format) || !Number.isInteger(frameCount) || frameCount < 1 || frameCount > 7200 ||
        !Number.isInteger(durationMs) || durationMs < 500 || durationMs > 30000 || !Number.isInteger(quality) || quality < 0 || quality > 100 ||
        !Number.isInteger(plays) || plays < 0 || plays > 65535 || !Number.isInteger(colors) || colors < 2 || colors > 256 ||
        ![renderWidth, renderHeight].every((n) => Number.isInteger(n) && n > 0) || renderWidth > width || renderHeight > height) throw new Error(`Invalid encoder options: ${JSON.stringify(options)}`);
    await encodeSupport({ ...options, fps: frameCount * 1000 / durationMs });
    this.options = options; this.index = 0; this.parts = [];
    this.canvas = document.createElement('canvas'); this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    if (format === 'gif') {
      this.parts.push(text('GIF89a'), new Uint8Array([...short(width), ...short(height), 0x70, 0, 0]));
      if (plays !== 1) this.parts.push(new Uint8Array([0x21, 0xFF, 11]), text('NETSCAPE2.0'), new Uint8Array([3, 1, ...short(plays === 0 ? 0 : plays - 1), 0]));
    } else if (format === 'webp' && frameCount > 1) {
      this.parts = webpHeader(width, height, plays);
    } else if (format === 'mp4') {
      const m = await mediabunny();
      this.target = new m.BufferTarget();
      this.output = new m.Output({ format: new m.Mp4OutputFormat({ fastStart: 'in-memory' }), target: this.target });
      this.video = new m.CanvasSource(this.canvas, { codec: 'avc', bitrate: Math.round(width * height * frameCount * 1000 / durationMs * (0.025 + quality * 0.002)), alpha: 'discard' });
      this.output.addVideoTrack(this.video, { frameRate: frameCount * 1000 / durationMs });
      await this.output.start();
    }
  }

  render(time) {
    const { width, height, renderWidth: rw, renderHeight: rh, background, format } = this.options;
    const rgba = this.engine.readPixels(time, rw, rh);
    const pixels = new Uint8ClampedArray(rgba.length);
    for (let p = 0; p < rgba.length; p += 4) {
      const a = rgba[p + 3]; pixels[p + 3] = a;
      for (let c = 0; c < 3; c++) pixels[p + c] = a ? Math.min(255, Math.round(rgba[p + c] * 255 / a)) : 0;
    }
    const x = Math.floor((width - rw) / 2), y = Math.floor((height - rh) / 2);
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.putImageData(new ImageData(pixels, rw, rh), x, y);
    if (format === 'mp4') {
      if (background == null || (background >>> 24) !== 255) throw new Error('MP4 requires an opaque background');
      this.ctx.globalCompositeOperation = 'destination-over';
      this.ctx.fillStyle = `#${(background & 0xFFFFFF).toString(16).padStart(6, '0')}`;
      this.ctx.fillRect(0, 0, width, height); this.ctx.globalCompositeOperation = 'source-over';
    }
    return this.ctx.getImageData(0, 0, width, height);
  }

  async webp(image, quality, forceWasm = false) {
    const colors = this.options.colors;
    if (colors < 256) {
      const { palette, indices } = quantize(image.data, Math.min(colors, 255), false, image.width, 1);
      for (let i = 0; i < indices.length; i++) {
        if (image.data[i * 4 + 3] === 0) continue;
        for (let c = 0; c < 3; c++) image.data[i * 4 + c] = palette[indices[i] * 3 + c];
      }
    }
    this.ctx.putImageData(image, 0, 0);
    if (!forceWasm) {
      const blob = await new Promise((resolve) => this.canvas.toBlob(resolve, 'image/webp', quality / 100));
      if (blob?.type === 'image/webp') return new Uint8Array(await blob.arrayBuffer());
    }
    this.fallback('WebP canvas encoder unavailable; using bundled libwebp WASM');
    const { default: encode } = await import('./vendor/jsquash-webp-1.5.0/encode.js');
    return new Uint8Array(await encode(image, { quality }));
  }

  async frame(index, time) {
    const o = this.options;
    if (!o || index !== this.index || index >= o.frameCount || !Number.isFinite(time) || time < 0 || time > o.durationMs / 1000) throw new Error(`Invalid encoder frame ${index} at ${time}`);
    const image = this.render(time);
    if (o.format === 'gif') {
      const { palette, indices } = quantize(image.data, Math.min(255, o.colors, 2 + Math.floor(o.quality * 253 / 100)), o.dither, o.width);
      this.parts.push(new Uint8Array([0x21, 0xF9, 4, 9, ...short(frameShare(index, o.frameCount, Math.round(o.durationMs / 10))), 255, 0, 0x2C,
        0, 0, 0, 0, ...short(o.width), ...short(o.height), 0x87]), palette, lzw(indices));
    } else if (o.format === 'webp') {
      const bytes = await this.webp(image, o.quality, o.forceWasm);
      this.parts.push(o.frameCount === 1 ? bytes : webpFrame(bytes, o.width, o.height, frameShare(index, o.frameCount, o.durationMs), index === 0));
    } else {
      await this.video.add(index * o.durationMs / o.frameCount / 1000, o.durationMs / o.frameCount / 1000);
    }
    this.index++;
  }

  async finish() {
    const o = this.options;
    if (!o || this.index !== o.frameCount) throw new Error(`Encoder received ${this.index}/${o?.frameCount} frames`);
    try {
      if (o.format === 'mp4') { this.video.close(); await this.output.finalize(); return new Uint8Array(this.target.buffer); }
      if (o.format === 'gif') return new Uint8Array(await new Blob([...this.parts, new Uint8Array([0x3B])]).arrayBuffer());
      if (o.frameCount === 1) return new Uint8Array(await new Blob(this.parts).arrayBuffer());
      const body = new Blob([text('WEBP'), ...this.parts]);
      const header = new Uint8Array(8); header.set(text('RIFF')); new DataView(header.buffer).setUint32(4, body.size, true);
      return new Uint8Array(await new Blob([header, body]).arrayBuffer());
    } finally { this.options = null; this.parts = []; this.output = this.target = this.video = this.canvas = this.ctx = null; }
  }

  async cancel() {
    if (this.output) await this.output.cancel();
    this.options = null; this.parts = []; this.output = this.target = this.video = this.canvas = this.ctx = null;
  }
}
