export const ENGINE_VERSION = '0.4.0';
export const SCENE_MODULES = { cube: './scenes/cube.js', ...Object.fromEntries([
  'random-rotations', 'figure-eight', 'wobbly-cube', 'diagonal-cube', 'photo-cube',
  'rotating-sphere', 'low-poly-sphere', 'inside-sphere', 'pyramid', 'rotating-donut', 'rotating-head', 'sun-and-planet', 'expanding-balloon',
].map((id) => [id, './scenes/shapes.js'])) };
const ALGORITHMS = ['ghost-trail', 'motion-blur', 'trailing-left', 'trailing-top', 'content-aware'];
export const CATEGORIES = ['spins', 'shapes', 'motion', 'distortion', 'glitch', 'grids', 'depth', 'filters'];
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const PARAMETER = /^[a-z][a-zA-Z0-9_]{0,47}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FILE = /^[a-zA-Z0-9_-]+\.(frag|png|webp|jpg)$/;
const TYPES = ['slider', 'toggle', 'color', 'choice'];
const UNIFORM_TYPES = { slider: 'float', toggle: 'bool', color: 'vec4', choice: 'int' };
const encoder = new TextEncoder();

function requireValue(ok, path, value) {
  if (!ok) throw new Error(`${path}: invalid ${JSON.stringify(value)}`);
}

function localized(value, path) {
  for (const language of ['tr', 'en']) {
    requireValue(typeof value?.[language] === 'string' && value[language].trim().length > 0, `${path}.${language}`, value?.[language]);
  }
}

export function compareVersions(a, b) {
  requireValue(typeof a === 'string' && typeof b === 'string' && VERSION.test(a) && VERSION.test(b), 'version', [a, b]);
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  requireValue([...left, ...right].every(Number.isSafeInteger), 'version', [a, b]);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

export function validateMetadata(m, { external = false } = {}) {
  requireValue(m && typeof m === 'object', 'package', m);
  requireValue(m.schemaVersion === 1, 'schemaVersion', m.schemaVersion);
  requireValue(typeof m.id === 'string' && ID.test(m.id), 'id', m.id);
  compareVersions(m.version, m.minimumEngineVersion);
  requireValue(compareVersions(m.minimumEngineVersion, ENGINE_VERSION) <= 0, 'minimumEngineVersion', m.minimumEngineVersion);
  localized(m.name, `${m.id}.name`);
  localized(m.description, `${m.id}.description`);
  requireValue(CATEGORIES.includes(m.category), 'category', m.category);
  requireValue(['animation', 'filter'].includes(m.kind), 'kind', m.kind);
  requireValue(['glsl', 'scene', 'algorithm'].includes(m.engineType), 'engineType', m.engineType);
  requireValue(!external || m.engineType === 'glsl', 'external.engineType', m.engineType);
  requireValue(m.engineType === 'glsl' ? FILE.test(m.entry) && m.entry.endsWith('.frag') :
    (m.engineType === 'scene' && Object.hasOwn(SCENE_MODULES, m.entry)) || (m.engineType === 'algorithm' && ALGORITHMS.includes(m.entry)), 'entry', m.entry);
  requireValue(['loop', 'once', 'static'].includes(m.durationBehavior), 'durationBehavior', m.durationBehavior);
  requireValue(['seamless', 'normal', 'none'].includes(m.loopBehavior), 'loopBehavior', m.loopBehavior);
  requireValue(['none', 'seeded', 'time-step'].includes(m.randomness), 'randomness', m.randomness);
  requireValue(m.capabilities?.alpha === true && m.capabilities?.webgl === 2, 'capabilities', m.capabilities);
  requireValue(['low', 'medium', 'high'].includes(m.capabilities?.cost), 'capabilities.cost', m.capabilities?.cost);
  requireValue(Array.isArray(m.capabilities?.platforms) && m.capabilities.platforms.length > 0 &&
    m.capabilities.platforms.every((p) => ['android', 'windows', 'web'].includes(p)), 'capabilities.platforms', m.capabilities?.platforms);
  for (const key of ['thumbnail', 'preview']) requireValue(FILE.test(m[key]) && !m[key].endsWith('.frag'), key, m[key]);
  requireValue(Array.isArray(m.assets), 'assets', m.assets);
  for (const asset of m.assets) {
    requireValue(FILE.test(asset.path), 'assets.path', asset.path);
    requireValue(typeof asset.source === 'string' && asset.source.length > 0 && typeof asset.license === 'string' && asset.license.length > 0, 'assets.license/source', asset);
  }
  requireValue(Array.isArray(m.parameters) && m.parameters.length <= 32, 'parameters', m.parameters);
  const ids = new Set();
  for (const p of m.parameters) {
    requireValue(typeof p.id === 'string' && PARAMETER.test(p.id) && !ids.has(p.id) &&
      !['source', 'resolution', 'time', 'progress', 'seed', 'image', 'imageAspect', 'fit', 'background', 'flipY', 'checker'].includes(p.id), 'parameter.id', p.id);
    ids.add(p.id);
    requireValue(TYPES.includes(p.type), `${p.id}.type`, p.type);
    localized(p.label, `${p.id}.label`);
    localized(p.description, `${p.id}.description`);
    if (p.type === 'slider') {
      requireValue([p.min, p.max, p.step].every(Number.isFinite) && p.min < p.max && p.step > 0 &&
        p.step <= p.max - p.min && Math.abs((p.max - p.min) / p.step - Math.round((p.max - p.min) / p.step)) < 1e-6,
      `${p.id}.range`, [p.min, p.max, p.step]);
    }
    if (p.type === 'choice') {
      requireValue(Array.isArray(p.options) && p.options.length > 0, `${p.id}.options`, p.options);
      const values = new Set();
      for (const option of p.options) {
        requireValue(Number.isInteger(option.value) && !values.has(option.value), `${p.id}.option.value`, option.value);
        values.add(option.value);
        localized(option.label, `${p.id}.option.label`);
      }
    }
    validateParameter(p, p.default);
  }
  return m;
}

export function validateParameter(p, value) {
  let ok;
  switch (p.type) {
    case 'slider': ok = Number.isFinite(value) && value >= p.min && value <= p.max &&
      Math.abs((value - p.min) / p.step - Math.round((value - p.min) / p.step)) < 1e-5; break;
    case 'toggle': ok = typeof value === 'boolean'; break;
    case 'color': ok = Array.isArray(value) && value.length === 4 && value.every((v) => Number.isFinite(v) && v >= 0 && v <= 1); break;
    case 'choice': ok = p.options.some((o) => o.value === value); break;
    default: ok = false;
  }
  requireValue(ok, `parameter.${p.id}`, value);
}

export function parameterValues(metadata, saved = {}) {
  const values = { ...saved };
  for (const key of Object.keys(saved)) requireValue(metadata.parameters.some((p) => p.id === key), `unknown parameter.${key}`, saved[key]);
  for (const p of metadata.parameters) {
    if (!Object.hasOwn(values, p.id)) values[p.id] = structuredClone(p.default);
    validateParameter(p, values[p.id]);
  }
  return values;
}

export function validateShader(source, metadata) {
  requireValue(typeof source === 'string' && source.length <= 64 * 1024, `${metadata.id}.GLSL.size`, source?.length);
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  requireValue(/void\s+main\s*\(/.test(code) && !/^\s*#version/m.test(code), `${metadata.id}.GLSL.main/version`, metadata.entry);
  const declared = new Set();
  for (const declaration of code.match(/\buniform\b[^;]*;/g) ?? []) {
    const match = declaration.match(/^uniform\s+(?:(?:lowp|mediump|highp)\s+)?(\w+)\s+u_(\w+)\s*;$/);
    const p = metadata.parameters.find((p) => p.id === match?.[2]);
    requireValue(p && match[1] === UNIFORM_TYPES[p.type] && !declared.has(p.id), `${metadata.id}.GLSL.uniform`, declaration);
    declared.add(p.id);
  }
  for (const p of metadata.parameters) requireValue(declared.has(p.id), `${metadata.id}.GLSL.missing uniform`, `u_${p.id}`);
}

export function bytesOf(file) {
  requireValue(file && ['utf8', 'base64'].includes(file.encoding) && typeof file.content === 'string' && file.content.length <= 6 * 1024 * 1024, 'file.encoding/size', file?.encoding);
  return file.encoding === 'utf8' ? encoder.encode(file.content) : Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
}

export async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function effectSpec(metadata, files, saved = {}, seed = 0) {
  requireValue(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffff, 'seed', seed);
  const params = parameterValues(metadata, saved);
  return { kind: metadata.engineType, module: metadata.entry, source: files[metadata.entry]?.content,
    params, seed, loop: metadata.durationBehavior === 'loop', randomness: metadata.randomness };
}

export class EffectRegistry {
  constructor() { this.packages = new Map(); }

  async add(pkg, { external = false } = {}) {
    const m = validateMetadata(pkg.metadata, { external });
    requireValue(pkg.files && typeof pkg.files === 'object' && pkg.checksums && typeof pkg.checksums === 'object', `${m.id}.files/checksums`, null);
    let size = 0;
    const required = [m.thumbnail, m.preview, ...m.assets.map((a) => a.path), ...(m.engineType === 'glsl' ? [m.entry] : [])];
    for (const file of required) requireValue(Object.hasOwn(pkg.files, file), `${m.id}.missing file`, file);
    requireValue(Object.keys(pkg.files).length <= 32 && Object.keys(pkg.files).length === Object.keys(pkg.checksums).length, `${m.id}.file count`, Object.keys(pkg.files).length);
    for (const [path, file] of Object.entries(pkg.files)) {
      requireValue(FILE.test(path), `${m.id}.file path`, path);
      const bytes = bytesOf(file);
      requireValue(bytes.length <= 4 * 1024 * 1024, `${m.id}.${path}.size`, bytes.length);
      if (path.endsWith('.frag')) requireValue(file.encoding === 'utf8', `${m.id}.${path}.encoding`, file.encoding);
      size += bytes.length;
      requireValue(await digest(bytes) === pkg.checksums[path], `${m.id}.${path}.checksum`, pkg.checksums[path]);
    }
    requireValue(size === pkg.packageSize && size <= 16 * 1024 * 1024, `${m.id}.packageSize`, pkg.packageSize);
    if (m.engineType === 'glsl') validateShader(pkg.files[m.entry].content, m);
    const key = `${m.id}@${m.version}`;
    const old = this.packages.get(key);
    requireValue(!old || JSON.stringify(old) === JSON.stringify(pkg), `immutable package ${key}`, key);
    this.packages.set(key, structuredClone(pkg));
    return m;
  }

  resolve(id, version) {
    const pkg = this.packages.get(`${id}@${version}`);
    if (!pkg) throw new Error(`package not installed: ${id}@${version}`);
    return pkg;
  }

  spec({ id, version, params, seed, intensity = 1, speed = 1 }) {
    const pkg = this.resolve(id, version);
    requireValue(Number.isFinite(intensity) && intensity >= 0 && intensity <= 1, `${id}.intensity`, intensity);
    requireValue(Number.isFinite(speed) && speed >= -10 && speed <= 10, `${id}.speed`, speed);
    return { ...effectSpec(pkg.metadata, pkg.files, params, seed), intensity, speed };
  }

  catalog() {
    return [...this.packages.values()].map((p) => p.metadata).sort((a, b) =>
      Number(a.kind === 'filter') - Number(b.kind === 'filter') ||
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
      a.id.localeCompare(b.id) || compareVersions(b.version, a.version));
  }

  async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const index = await response.json();
    requireValue(index.schemaVersion === 1 && Array.isArray(index.packages), 'index', index);
    for (const pkg of index.packages) await this.add(pkg);
  }
}
