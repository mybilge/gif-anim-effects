import * as THREE from './vendor/three-0.186.1/three.module.js';

export function contentMapping(pixels, width, height, strength) {
  const columns = new Float64Array(width), rows = new Float64Array(height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    const right = (y * width + Math.min(x + 1, width - 1)) * 4;
    const above = (Math.min(y + 1, height - 1) * width + x) * 4;
    let energy = 0;
    for (let c = 0; c < 4; c++) energy += Math.abs(pixels[i + c] - pixels[right + c]) + Math.abs(pixels[i + c] - pixels[above + c]);
    columns[x] += energy; rows[y] += energy;
  }
  function inverse(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    const mean = total / weights.length;
    const density = Array.from(weights, (w) => 1 - strength * 0.85 + strength * 0.85 * (mean > 0 ? w / mean : 1));
    const sum = density.reduce((a, b) => a + b, 0);
    const result = [];
    let cell = 0, accumulated = 0;
    for (let i = 0; i < 128; i++) {
      const position = i / 127 * sum;
      while (cell < density.length - 1 && accumulated + density[cell] < position) accumulated += density[cell++];
      result.push((cell + (position - accumulated) / density[cell]) / weights.length);
    }
    return result;
  }
  const x = inverse(columns), y = inverse(rows), mapping = new Float32Array(128 * 4);
  for (let i = 0; i < 128; i++) { mapping[i * 4] = x[i]; mapping[i * 4 + 1] = y[i]; }
  return mapping;
}

export function create(engine, { amount }, loop) {
  const analysis = new THREE.WebGLRenderTarget(64, 64, { depthBuffer: false });
  const pixels = new Uint8Array(64 * 64 * 4);
  const mapping = new THREE.DataTexture(new Float32Array(128 * 4), 128, 1, THREE.RGBAFormat, THREE.FloatType);
  const copy = engine.material(`precision highp float;
uniform sampler2D u_source;
in vec2 v_uv;
out vec4 fragColor;
void main() { fragColor = texture(u_source, v_uv); }`, {});
  const warp = engine.material(`precision highp float;
uniform sampler2D u_source;
uniform sampler2D u_mapping;
in vec2 v_uv;
out vec4 fragColor;
float coordinate(float value, int channel) {
  float position = value * 127.0;
  int cell = min(126, int(floor(position)));
  return mix(texelFetch(u_mapping, ivec2(cell, 0), 0)[channel], texelFetch(u_mapping, ivec2(cell + 1, 0), 0)[channel], position - float(cell));
}
void main() { fragColor = texture(u_source, vec2(coordinate(v_uv.x, 0), coordinate(v_uv.y, 1))); }`, { u_mapping: mapping });
  return {
    render(input, target, frame) {
      copy.uniforms.u_source.value = input;
      engine.pass(copy, analysis);
      engine.renderer.readRenderTargetPixels(analysis, 0, 0, 64, 64, pixels);
      mapping.image.data = contentMapping(pixels, 64, 64, amount * Math.sin(Math.PI * frame.progress(loop)) ** 2);
      mapping.needsUpdate = true;
      warp.uniforms.u_source.value = input;
      engine.pass(warp, target);
    },
    dispose() { analysis.dispose(); mapping.dispose(); copy.dispose(); warp.dispose(); },
  };
}
