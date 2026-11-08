// Same histogram median-cut and ordered dithering as Android's Palette.kt.
export function quantize(rgba, colors, dither, width, alphaThreshold = 128) {
  const counts = new Uint32Array(32768);
  const sums = Array.from({ length: 3 }, () => new Float64Array(32768));
  for (let p = 0; p < rgba.length; p += 4) {
    if (rgba[p + 3] < alphaThreshold) continue;
    const key = (rgba[p] >> 3 << 10) | (rgba[p + 1] >> 3 << 5) | (rgba[p + 2] >> 3);
    counts[key]++;
    for (let c = 0; c < 3; c++) sums[c][key] += rgba[p + c];
  }
  const component = (key, c) => Math.floor(sums[c][key] / counts[key]);
  const box = (keys) => {
    const ranges = [0, 1, 2].map((c) => {
      let min = 255, max = 0;
      for (const key of keys) { const value = component(key, c); min = Math.min(min, value); max = Math.max(max, value); }
      return max - min;
    });
    const axis = ranges.indexOf(Math.max(...ranges));
    const population = keys.reduce((sum, key) => sum + counts[key], 0);
    return { keys, axis, population, score: keys.length > 1 ? population * ranges[axis] : 0 };
  };
  const used = Array.from(counts.keys()).filter((key) => counts[key]);
  const boxes = used.length ? [box(used)] : [];
  while (boxes.length < colors) {
    const selected = boxes.reduce((best, current) => current.score > (best?.score ?? -1) ? current : best, null);
    if (!selected?.score) break;
    const sorted = selected.keys.sort((a, b) => component(a, selected.axis) - component(b, selected.axis));
    let sum = 0, split = 0;
    while (split < sorted.length - 1 && sum < selected.population / 2) sum += counts[sorted[split++]];
    split = Math.max(1, split);
    boxes.splice(boxes.indexOf(selected), 1, box(sorted.slice(0, split)), box(sorted.slice(split)));
  }
  const palette = new Uint8Array(768);
  boxes.forEach((b, i) => {
    for (let c = 0; c < 3; c++) palette[i * 3 + c] = Math.floor(b.keys.reduce((sum, key) => sum + sums[c][key], 0) / b.population);
  });
  const nearest = new Int16Array(32768).fill(-1);
  const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const indices = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < indices.length; i++) {
    const p = i * 4;
    if (rgba[p + 3] < alphaThreshold) { indices[i] = 255; continue; }
    const delta = dither ? bayer[(Math.floor(i / width) % 4) * 4 + i % width % 4] - 8 : 0;
    const rgb = [0, 1, 2].map((c) => Math.max(0, Math.min(255, rgba[p + c] + delta)));
    const key = (rgb[0] >> 3 << 10) | (rgb[1] >> 3 << 5) | (rgb[2] >> 3);
    if (nearest[key] < 0) {
      let distance = Infinity;
      for (let c = 0; c < boxes.length; c++) {
        const d = rgb.reduce((sum, v, channel) => sum + (palette[c * 3 + channel] - v) ** 2, 0);
        if (d < distance) { distance = d; nearest[key] = c; }
      }
    }
    indices[i] = nearest[key];
  }
  return { palette, indices };
}
