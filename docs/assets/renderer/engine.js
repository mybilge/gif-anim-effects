import * as THREE from './vendor/three-0.186.1/three.module.js';
import { SCENE_MODULES } from './packages.js';
import { create as createContentAware } from './content-aware.js';
import { create as createRandomPerFrame } from './random-per-frame.js';

// Pixels pass through as stored sRGB bytes; no color conversion anywhere.
THREE.ColorManagement.enabled = false;

const VERTEX = `precision highp float;
in vec3 position;
out vec2 v_uv;
void main() {
  v_uv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// Effect shader contract: layers hold premultiplied RGBA, v_uv (0,0) is bottom-left,
// u_progress is fract (looping) or clamp (one-shot) of t / duration * project speed * effect speed (README §4.3).
const PRELUDE = `precision highp float;
precision highp int;
uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_progress;
uniform float u_seed;
in vec2 v_uv;
out vec4 fragColor;
`;

const PLACE = `${PRELUDE}
uniform sampler2D u_image;
uniform float u_imageAspect;
uniform int u_fit;
uniform float u_scale;
uniform vec2 u_offset;
void main() {
  float r = (u_resolution.x / u_resolution.y) / u_imageAspect;
  vec2 s = vec2(1.0);
  if (u_fit == 0) s = r > 1.0 ? vec2(r, 1.0) : vec2(1.0, 1.0 / r);
  if (u_fit == 1) s = r > 1.0 ? vec2(1.0, 1.0 / r) : vec2(r, 1.0);
  vec2 uv = ((v_uv - 0.5 - vec2(u_offset.x, -u_offset.y)) / u_scale) * s + 0.5;
  bool inside = all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)));
  // Source rows arrive top-down.
  fragColor = inside ? texture(u_image, vec2(uv.x, 1.0 - uv.y)) : vec4(0.0);
}`;

const FINAL = `${PRELUDE}
uniform vec4 u_background;
uniform bool u_flipY;
uniform bool u_checker;
void main() {
  vec4 c = texture(u_source, u_flipY ? vec2(v_uv.x, 1.0 - v_uv.y) : v_uv);
  vec4 bg = u_background;
  if (u_checker) {
    vec2 cell = floor(gl_FragCoord.xy / 16.0);
    float k = mod(cell.x + cell.y, 2.0) < 1.0 ? 0.8 : 0.6;
    bg += vec4(vec3(k), 1.0) * (1.0 - bg.a);
  }
  fragColor = c + bg * (1.0 - c.a);
}`;

const FIT = { fit: 0, fill: 1, stretch: 2 };

export class Engine {
  constructor(canvas) {
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, premultipliedAlpha: true, antialias: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      this.shaderError = gl.getShaderInfoLog(fs) || gl.getShaderInfoLog(vs) || gl.getProgramInfoLog(program);
    };
    this.camera = new THREE.OrthographicCamera();
    const triangle = new THREE.BufferGeometry();
    triangle.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(triangle);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene().add(this.quad);
    this.layers = Array.from({ length: 3 }, () => new THREE.WebGLRenderTarget(1, 1));
    this.historyLayers = [];
    this.output = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.probe = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    this.place = this.material(PLACE, { u_image: null, u_imageAspect: 1, u_fit: 0, u_scale: 1, u_offset: new THREE.Vector2() });
    this.mix = this.material(`${PRELUDE}
uniform sampler2D u_effect;
uniform float u_intensity;
void main() { fragColor = mix(texture(u_source, v_uv), texture(u_effect, v_uv), u_intensity); }
`, { u_effect: null, u_intensity: 1 });
    this.final = this.material(FINAL, { u_background: new THREE.Vector4(), u_flipY: false, u_checker: false });
    this.image = null;
    this.images = new Map();
    this.previewMaxEdge = null;
    this.runtimeErrors = [];
    this.effects = [];
    this.project = { fit: 'fit', background: null, duration: 3, speed: 1 };
    // Release old GL handles while lost; CPU textures, geometry and uniforms remain reusable.
    this.onContextLost = () => this.releaseResources();
    canvas.addEventListener('webglcontextlost', this.onContextLost);
  }

  material(fragment, uniforms) {
    const all = { u_source: null, u_resolution: new THREE.Vector2(), u_time: 0, u_progress: 0, u_seed: 0, ...uniforms };
    return new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      vertexShader: VERTEX,
      fragmentShader: fragment,
      uniforms: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, { value: v }])),
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
  }

  pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  /** rgba: premultiplied, rows top-down. */
  setSource(rgba, width, height, id = 'main') {
    if (id !== 'main' && !/^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(id)) throw new Error(`Invalid source id: ${id}`);
    const limit = this.renderer.capabilities.maxTextureSize;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > limit || height > limit || rgba.length !== width * height * 4) {
      throw new Error(`Invalid source ${width}x${height}, ${rgba.length} bytes; GPU texture limit ${limit}`);
    }
    this.images.get(id)?.dispose();
    const image = new THREE.DataTexture(rgba, width, height);
    image.minFilter = THREE.LinearMipmapLinearFilter;
    image.magFilter = THREE.LinearFilter;
    image.generateMipmaps = true;
    image.needsUpdate = true;
    this.images.set(id, image);
    if (id === 'main') {
      this.image = image;
      this.place.uniforms.u_image.value = image;
      this.place.uniforms.u_imageAspect.value = width / height;
    }
  }

  retainSources(ids) {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error(`Invalid source list: ${JSON.stringify(ids)}`);
    for (const [id, image] of this.images) {
      if (id !== 'main' && !ids.includes(id)) { image.dispose(); this.images.delete(id); }
    }
  }

  /** Returns per-effect errors; failed effects are left out, the rest keep working (README §13). */
  async setStack(specs, { atomic = false } = {}) {
    const effects = [];
    const errors = [];
    for (const [index, spec] of specs.entries()) {
      try {
        const images = spec.images ?? [];
        for (const image of images) if (!this.images.has(image.id)) throw new Error(`Source image not loaded: ${image.id}`);
        const effect = await this.createEffect(spec);
        const targets = images.map(() => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }));
        effects.push({ ...effect, index, images, imageTargets: targets,
          dispose: () => { effect.dispose(); targets.forEach((t) => t.dispose()); },
          loop: spec.loop ?? true, intensity: spec.intensity ?? 1, speed: spec.speed ?? 1 });
      } catch (e) {
        errors.push({ index, message: String(e?.message ?? e) });
      }
    }
    if (atomic && errors.length) {
      effects.forEach((e) => e.dispose());
      return { errors };
    }
    this.effects.forEach((e) => e.dispose());
    this.historyLayers.forEach((layers) => layers?.forEach((t) => t.dispose()));
    this.historyLayers = [];
    this.effects = effects;
    this.runtimeErrors = [];
    this.hasLoop = effects.some((e) => e.loop);
    return { errors };
  }

  async createEffect(spec) {
    if (spec.kind === 'glsl') return this.glslEffect(spec);
    if (spec.kind === 'scene') {
      const url = SCENE_MODULES[spec.module];
      if (!url) throw new Error(`unknown scene module ${spec.module}`);
      return (await import(url)).create(this.renderer, spec.params, spec.loop, spec.module, spec.seed);
    }
    if (spec.kind === 'algorithm') {
      if (spec.module === 'content-aware') return createContentAware(this, spec.params, spec.loop);
      if (spec.module === 'random-per-frame') return createRandomPerFrame(this, spec);
      if (['ghost-trail', 'motion-blur', 'trailing-left', 'trailing-top'].includes(spec.module)) return this.historyEffect(spec);
    }
    throw new Error(`unknown effect kind ${spec.kind}`);
  }

  historyEffect({ module, loop, speed = 1, params }) {
    const scroll = module === 'trailing-left' || module === 'trailing-top';
    const targets = [new THREE.WebGLRenderTarget(1, 1), new THREE.WebGLRenderTarget(1, 1)];
    const material = this.material(`${PRELUDE}
uniform sampler2D u_history;
uniform float u_decay;
uniform vec2 u_offset;
uniform bool u_first;
void main() {
  vec4 c = texture(u_source, v_uv);
  vec4 past = texture(u_history, ${scroll ? 'fract(v_uv + u_offset)' : 'v_uv'});
  fragColor = ${module === 'motion-blur' ? '(c + past * u_decay) / (1.0 + u_decay)' : 'c + past * u_decay * (1.0 - c.a)'};
  ${scroll ? 'if (u_first) fragColor = past;' : ''}
}`, { u_history: null, u_decay: params.decay, u_offset: new THREE.Vector2(), u_first: false });
    return {
      render: (input, target, frame) => {
        targets.forEach((t) => t.setSize(frame.width, frame.height));
        material.uniforms.u_decay.value = params.decay;
        let current = input;
        if (scroll) {
          material.uniforms.u_first.value = true;
          material.uniforms.u_history.value = input;
          material.uniforms.u_source.value = input;
          material.uniforms.u_offset.value.set(module === 'trailing-left' ? frame.progress(loop) : 0, module === 'trailing-top' ? -frame.progress(loop) : 0);
          this.pass(material, targets[0]);
          material.uniforms.u_first.value = false;
          current = targets[0].texture;
        }
        for (let i = 1; i <= params.samples; i++) {
          const past = frame.sample(frame.t - i * params.spacing * this.project.duration);
          material.uniforms.u_source.value = current;
          material.uniforms.u_history.value = past;
          if (scroll) {
            const phase = this.progress(frame.t - i * params.spacing * this.project.duration, loop, speed);
            material.uniforms.u_offset.value.set(module === 'trailing-left' ? phase : 0, module === 'trailing-top' ? -phase : 0);
          }
          const next = i === params.samples ? target : targets[i % 2];
          this.pass(material, next);
          current = next.texture;
        }
      },
      dispose: () => { material.dispose(); targets.forEach((t) => t.dispose()); },
    };
  }

  glslEffect({ source, params = {}, seed = 0, loop = true, images = [] }) {
    const uniforms = Object.fromEntries(Object.entries(params).map(([k, v]) => [`u_${k}`, v]));
    const count = images.length + 1;
    const limit = this.renderer.getContext().getParameter(this.renderer.getContext().MAX_TEXTURE_IMAGE_UNITS);
    if (count > limit) throw new Error(`Effect needs ${count} image textures; GPU limit ${limit}`);
    const declarations = Array.from({ length: count }, (_, i) => `uniform sampler2D u_input${i};`).join('\n');
    const branches = Array.from({ length: count }, (_, i) => `if (slot == ${i}) return texture(u_input${i}, uv);`).join('\n');
    const inputs = `${declarations}\nconst int inputCount = ${count};\nvec4 imageAt(int slot, vec2 uv) { slot = ((slot % inputCount) + inputCount) % inputCount; ${branches} return vec4(0.0); }\n`;
    const material = this.material(PRELUDE + inputs + source, { ...uniforms, u_seed: seed,
      ...Object.fromEntries(Array.from({ length: count }, (_, i) => [`u_input${i}`, this.image])) });
    this.shaderError = null;
    this.pass(material, this.probe);
    const gl = this.renderer.getContext(), error = gl.getError();
    if (this.shaderError || error !== gl.NO_ERROR) {
      material.dispose();
      throw new Error(this.shaderError ?? `Shader smoke draw failed: ${error}`);
    }
    return {
      render: (input, target, frame) => {
        const u = material.uniforms;
        for (const [id, value] of Object.entries(params)) u[`u_${id}`].value = value;
        u.u_source.value = input;
        for (let i = 0; i < count; i++) u[`u_input${i}`].value = frame.inputs?.[i] ?? input;
        u.u_resolution.value.set(frame.width, frame.height);
        u.u_time.value = frame.t;
        u.u_progress.value = frame.progress(loop);
        this.pass(material, target);
      },
      dispose: () => material.dispose(),
    };
  }

  progress(t, loop, speed = 1) {
    const rate = this.project.speed * speed;
    const p = (t / this.project.duration) * rate;
    if (loop) return p - Math.floor(p);
    // Backwards, a one-shot effect starts at its end state.
    return Math.min(Math.max(rate < 0 ? 1 + p : p, 0), 1);
  }

  renderLayers(t, width, height) {
    return this.renderPrefix(t, width, height, this.effects.length, 0);
  }

  renderPrefix(t, width, height, count, depth, sourceId = 'main', placement = this.project) {
    const image = this.images.get(sourceId);
    if (!image) throw new Error(`Source image not loaded: ${sourceId}`);
    const layers = depth === 0 ? this.layers : (this.historyLayers[depth] ??= Array.from({ length: 3 }, () => new THREE.WebGLRenderTarget(1, 1)));
    for (const layer of layers) layer.setSize(width, height);
    const u = this.place.uniforms;
    u.u_image.value = image;
    u.u_imageAspect.value = image.image.width / image.image.height;
    u.u_resolution.value.set(width, height);
    u.u_fit.value = FIT[this.project.fit];
    u.u_scale.value = placement.scale ?? 1;
    u.u_offset.value.fromArray(placement.offset ?? [0, 0]);
    this.pass(this.place, layers[0]);
    const frame = { t, width, height };
    let current = 0;
    for (let index = 0; index < count; index++) {
      frame.progress = (loop) => this.progress(t, loop, this.effects[index].speed);
      frame.sample = (time) => {
        const duration = this.project.duration;
        const previous = this.hasLoop ? ((time % duration) + duration) % duration : Math.max(0, time);
        return this.renderPrefix(previous, width, height, index, depth + 1, sourceId, placement);
      };
      const effect = this.effects[index];
      if (effect.intensity === 0 || effect.failed) continue;
      const next = (current + 1) % 3;
      try {
        frame.inputs = [layers[current].texture];
        for (const [i, source] of (effect.images ?? []).entries()) {
          const texture = this.renderPrefix(t, width, height, index, depth + 1, source.id, source);
          const target = effect.imageTargets[i];
          target.setSize(width, height);
          this.mix.uniforms.u_source.value = texture;
          this.mix.uniforms.u_effect.value = texture;
          this.mix.uniforms.u_intensity.value = 0;
          this.pass(this.mix, target);
          frame.inputs.push(target.texture);
        }
        effect.render(layers[current].texture, layers[next], frame);
      } catch (e) {
        effect.failed = true;
        this.runtimeErrors.push({ index: effect.index, message: String(e?.message ?? e) });
        continue;
      }
      if (effect.intensity === 1) current = next;
      else {
        const mixed = (current + 2) % 3;
        this.mix.uniforms.u_source.value = layers[current].texture;
        this.mix.uniforms.u_effect.value = layers[next].texture;
        this.mix.uniforms.u_intensity.value = effect.intensity;
        this.pass(this.mix, layers[mixed]);
        current = mixed;
      }
    }
    return layers[current].texture;
  }

  composite(texture, target, flipY, checker) {
    const u = this.final.uniforms;
    const [r, g, b, a] = this.project.background ?? [0, 0, 0, 0];
    u.u_source.value = texture;
    u.u_background.value.set(r * a, g * a, b * a, a);
    u.u_flipY.value = flipY;
    u.u_checker.value = checker;
    this.pass(this.final, target);
  }

  resize() {
    const canvas = this.renderer.domElement;
    const bounds = canvas.getBoundingClientRect();
    const width = Math.round(bounds.width * window.devicePixelRatio), height = Math.round(bounds.height * window.devicePixelRatio);
    const edge = Math.max(width, height);
    const scale = this.previewMaxEdge && edge > 0 ? Math.min(1, this.previewMaxEdge / edge) : 1;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(Math.round(width * scale), Math.round(height * scale), false);
  }

  /** Preview on the canvas, transparency shown as a checkerboard (README §3.2). */
  draw(t) {
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    if (!this.image || size.x === 0 || size.y === 0) return;
    this.output.setSize(1, 1);
    this.composite(this.renderLayers(t, size.x, size.y), null, false, true);
  }

  /** The frame at time t as premultiplied RGBA, rows top-down. */
  readPixels(t, width, height) {
    const gl = this.renderer.getContext();
    if (gl.isContextLost()) throw new Error('WebGL context lost; frame unavailable');
    const limit = this.renderer.capabilities.maxTextureSize;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > limit || height > limit) {
      throw new Error(`Invalid frame ${width}x${height}; GPU texture limit ${limit}`);
    }
    if (this.runtimeErrors.length) throw new Error(`Effects failed: ${JSON.stringify(this.runtimeErrors)}`);
    this.output.setSize(width, height);
    this.composite(this.renderLayers(t, width, height), this.output, true, false);
    if (gl.isContextLost()) throw new Error('WebGL context lost during frame');
    if (this.runtimeErrors.length) throw new Error(`Effects failed: ${JSON.stringify(this.runtimeErrors)}`);
    const pixels = new Uint8Array(width * height * 4);
    this.renderer.readRenderTargetPixels(this.output, 0, 0, width, height, pixels);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL frame ${width}x${height} failed: ${error}`);
    return pixels;
  }

  releaseResources() {
    this.effects.forEach((e) => e.dispose());
    [this.layers, ...this.historyLayers].forEach((layers) => layers?.forEach((t) => t.dispose()));
    [this.output, this.probe, this.place, this.mix, this.final, ...this.images.values(), this.quad.geometry].forEach((r) => r?.dispose());
  }

  dispose() {
    this.renderer.domElement.removeEventListener('webglcontextlost', this.onContextLost);
    this.releaseResources();
    this.renderer.dispose();
  }
}
