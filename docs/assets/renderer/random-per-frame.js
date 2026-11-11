import * as THREE from './vendor/three-0.186.1/three.module.js';

function hash(value) {
  value = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  value = Math.imul(value ^ (value >>> 15), 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

export function randomPlan(pool, seed, time, rate) {
  const tick = Math.floor(time * rate);
  let state = hash((tick >>> 0) ^ Math.imul(seed + 1, 0x9e3779b9));
  const next = () => { state = hash(state + 0x9e3779b9); return state / 4294967296; };
  const plan = { time: tick / rate };
  for (const kind of ['animation', 'filter']) {
    const entries = pool.filter((p) => p.metadata.kind === kind);
    const entry = entries[Math.floor(next() * entries.length)];
    const params = {};
    for (const p of entry.metadata.parameters) {
      if (p.type === 'slider') params[p.id] = Math.min(p.max, p.min + Math.floor(next() * (Math.round((p.max - p.min) / p.step) + 1)) * p.step);
      else if (p.type === 'toggle') params[p.id] = next() < 0.5;
      else if (p.type === 'choice') params[p.id] = p.options[Math.floor(next() * p.options.length)].value;
      else if (p.type === 'color') params[p.id] = [next(), next(), next(), next()];
    }
    plan[kind] = { entry, params, phase: next() };
  }
  return plan;
}

export async function create(engine, { pool, seed, params, speed = 1 }) {
  const children = [];
  for (const entry of pool) {
    try { children.push({ ...entry, effect: await engine.createEffect(entry.spec) }); }
    catch (error) {
      children.forEach((child) => child.effect.dispose());
      throw new Error(`random-per-frame: ${entry.metadata.id}@${entry.metadata.version} initialization failed: ${error.message}`, { cause: error });
    }
  }
  const targets = Array.from({ length: 2 }, () => new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false }));
  const render = (selection, time, input, target, frame) => {
    const { entry } = selection;
    Object.assign(entry.spec.params, selection.params);
    entry.effect.render(input, target, { ...frame, inputs: [input], t: time,
      progress: (loop) => engine.progress(selection.phase * engine.project.duration, loop, speed) });
  };
  return {
    render(input, target, frame) {
      targets.forEach((t) => t.setSize(frame.width, frame.height));
      const plan = randomPlan(children, seed, frame.t, params.rate);
      const inputs = frame.inputs ?? [input];
      input = inputs[hash(seed ^ Math.floor(frame.t * params.rate)) % inputs.length];
      render(plan.animation, plan.time, input, targets[0], frame);
      render(plan.filter, plan.time, targets[0].texture, target, { ...frame, sample: (time) => {
        const duration = engine.project.duration;
        const previous = ((time % duration) + duration) % duration;
        const past = randomPlan(children, seed, previous, params.rate);
        // History sees the animation selected at that past time, before the filter.
        render(past.animation, past.time, frame.sample(previous), targets[1], frame);
        return targets[1].texture;
      } });
    },
    dispose() { children.forEach((entry) => entry.effect.dispose()); targets.forEach((t) => t.dispose()); },
  };
}
