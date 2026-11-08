import { Engine } from './engine.js';
import { EffectRegistry } from './packages.js';
import { PreviewQuality } from './preview.js';

// Android injects gifAnimHost (WebMessageListener, takes strings and ArrayBuffers); WebView2 has chrome.webview.
const host = window.gifAnimHost;
const desktop = window.chrome?.webview;
const send = host ? (m) => host.postMessage(JSON.stringify(m)) : desktop ? (m) => desktop.postMessage(m) : (m) => {
  const result = m.result;
  const binaryKey = result?.rgba ? 'rgba' : result?.bytes ? 'bytes' : null;
  const pixels = binaryKey ? result[binaryKey] : null;
  const json = JSON.stringify(binaryKey ? { ...result, [binaryKey]: undefined } : result ?? null);
  parent.postMessage({ ...m, result: undefined, json, binaryKey, pixels }, location.origin, pixels ? [pixels.buffer] : []);
};

addEventListener('error', (e) => send({ event: 'error', message: `${e.message} @ ${e.filename}:${e.lineno}` }));
addEventListener('unhandledrejection', (e) => send({ event: 'error', message: String(e.reason?.stack ?? e.reason) }));

function encodeBase64(bytes) {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

const decodeBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function start(engine) {
  let encoder;
  let outputUrl;
  const encoderWarnings = new Set();
  const browserEncoder = async () => {
    if (!encoder) {
      const { BrowserEncoder } = await import('./encoders.js');
      encoder = new BrowserEncoder(engine, (message) => {
        encoderWarnings.add(message);
        send({ event: 'fallback', message });
      });
    }
    return encoder;
  };
  const registry = new EffectRegistry();
  const packagesReady = registry.load(new URL('../assets/effects/index.json', import.meta.url));
  let playing = false;
  let t = 0;
  let startedAt = 0;
  let scheduled = false;
  let contextLost = false;
  let recoveries = 0;
  const quality = new PreviewQuality();

  const tick = (now) => {
    scheduled = false;
    if (contextLost) return;
    if (playing) t = ((now - startedAt) / 1000) % engine.project.duration;
    engine.draw(t);
    if (playing && engine.image && quality.sample(now, Math.max(engine.renderer.domElement.width, engine.renderer.domElement.height))) {
      engine.previewMaxEdge = quality.maxEdge;
      engine.resize();
    }
    if (playing) schedule();
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(tick);
  };
  engine.renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    contextLost = true;
    quality.reset();
  });
  engine.renderer.domElement.addEventListener('webglcontextrestored', () => {
    contextLost = false;
    recoveries++;
    if (engine.image) engine.image.needsUpdate = true;
    startedAt = performance.now() - t * 1000;
    engine.resize();
    schedule();
  });
  new ResizeObserver(() => {
    engine.resize();
    schedule();
  }).observe(engine.renderer.domElement);

  const commands = {
    async encodeSupport(options) {
      const { encodeSupport } = await import('./encoders.js');
      return encodeSupport(options);
    },
    async probeMp4({ pixels, url }) {
      const m = await import('./vendor/mediabunny-1.65.2/dist/bundles/mediabunny.mjs');
      if (url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`probe fetch: HTTP ${response.status}`);
        pixels = new Uint8Array(await response.arrayBuffer());
      }
      const input = new m.Input({ source: new m.BufferSource(new Uint8Array(pixels)), formats: [new m.Mp4InputFormat()] });
      try {
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error('MP4 has no video track');
        let decoded = 0;
        for await (const sample of new m.VideoSampleSink(track).samples()) { sample.close(); decoded++; }
        return { width: await track.getDisplayWidth(), height: await track.getDisplayHeight(), frames: decoded,
          packets: (await track.computePacketStats()).packetCount, codec: await track.getCodec(),
          durationMs: Math.round(await input.computeDuration() * 1000), hasAudio: (await input.getAudioTracks()).length > 0 };
      } finally { input.dispose(); }
    },
    async encodeStart(options) {
      outputUrl = options.outputUrl;
      const e = await browserEncoder();
      try { await e.start(options); }
      catch (error) { await e.cancel(); throw error; }
    },
    async encodeFrame({ index, time }) {
      await (await browserEncoder()).frame(index, time);
      return { warnings: [...encoderWarnings] };
    },
    async encodeFinish() {
      const bytes = await (await browserEncoder()).finish();
      if (!outputUrl) return { bytes };
      const response = await fetch(outputUrl, { method: 'POST', body: bytes });
      if (!response.ok) throw new Error(`output upload: HTTP ${response.status}`);
      return { size: bytes.length };
    },
    async encodeCancel() { await encoder?.cancel(); },
    async webpSizes({ time, qualities, ...options }) {
      const e = await browserEncoder();
      try {
        await e.start({ ...options, format: 'webp', frameCount: 1 });
        const image = e.render(time);
        const { webpFrame } = await import('./encoders.js');
        const sizes = [];
        for (const q of qualities) {
          const bytes = await e.webp(new ImageData(new Uint8ClampedArray(image.data), image.width, image.height), q);
          sizes.push(options.still ? bytes.length : webpFrame(bytes, options.width, options.height, 100).size);
        }
        return sizes;
      } finally { await e.cancel(); }
    },
    async catalog() {
      await packagesReady;
      return registry.catalog();
    },
    async install({ packages }) {
      await packagesReady;
      const errors = [];
      for (const [index, pkg] of packages.entries()) {
        try {
          const m = await registry.add(pkg, { external: true });
          // Smoke test before the package is offered: compile and draw once (README §10.1).
          try {
            (await engine.createEffect(registry.spec({ id: m.id, version: m.version }))).dispose();
          } catch (e) {
            registry.packages.delete(`${m.id}@${m.version}`);
            throw e;
          }
        } catch (e) {
          errors.push({ index, message: String(e.message) });
        }
      }
      return { errors };
    },
    async source({ width, height, url, base64, pixels }) {
      let bytes;
      if (url) {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`source fetch ${url}: HTTP ${response.status}`);
        bytes = new Uint8Array(await response.arrayBuffer());
      } else if (pixels) {
        bytes = new Uint8Array(pixels);
      } else {
        bytes = decodeBase64(base64);
      }
      if (bytes.length !== width * height * 4) throw new Error(`source is ${bytes.length} bytes, expected ${width}x${height} RGBA`);
      engine.setSource(bytes, width, height);
      schedule();
    },
    project({ fit, background, durationMs, speed, scale = 1, offset = [0, 0] }) {
      if (!(durationMs >= 500 && durationMs <= 30000 && Number.isFinite(speed) && speed >= -10 && speed <= 10) ||
          !['fit', 'fill', 'stretch'].includes(fit) || !Number.isFinite(scale) || scale < 0.1 || scale > 4 ||
          !Array.isArray(offset) || offset.length !== 2 || offset.some((v) => !Number.isFinite(v) || Math.abs(v) > 1)) {
        throw new Error(`invalid project: ${JSON.stringify({ fit, durationMs, speed, scale, offset })}`);
      }
      engine.project = { fit, background, duration: durationMs / 1000, speed, scale, offset };
      t %= engine.project.duration;
      if (playing) startedAt = performance.now() - t * 1000;
      schedule();
    },
    status() { return { t, playing, contextLost, recoveries, fps: quality.fps, previewMaxEdge: quality.maxEdge, width: engine.renderer.domElement.width, height: engine.renderer.domElement.height, errors: engine.runtimeErrors }; },
    async stack({ effects, atomic = false }) {
      await packagesReady;
      const errors = [];
      const specs = [];
      for (const [index, effect] of effects.entries()) {
        try { specs.push({ index, spec: effect.id ? registry.spec(effect) : effect }); }
        catch (e) { errors.push({ index, message: String(e.message) }); }
      }
      if (atomic && errors.length) return { errors };
      const result = await engine.setStack(specs.map((e) => e.spec), { atomic });
      if (!atomic || result.errors.length === 0) {
        for (const effect of engine.effects) effect.index = specs[effect.index].index;
      }
      result.errors = [...errors, ...result.errors.map((e) => ({ ...e, index: specs[e.index].index }))];
      schedule();
      return result;
    },
    play() {
      quality.reset();
      playing = true;
      startedAt = performance.now() - t * 1000;
      schedule();
    },
    pause() {
      playing = false;
      return { t };
    },
    seek({ t: time }) {
      playing = false;
      t = time;
      schedule();
    },
    async frame({ t: time, width, height, outputUrl }) {
      const started = performance.now();
      const pixels = engine.readPixels(time, width, height);
      const jsMs = performance.now() - started;
      if (outputUrl) {
        const response = await fetch(outputUrl, { method: 'POST', body: pixels });
        if (!response.ok) throw new Error(`frame upload: HTTP ${response.status}`);
        return { jsMs };
      }
      if (!host) return desktop ? { jsMs, base64: encodeBase64(pixels) } : { jsMs, rgba: pixels };
      host.postMessage(pixels.buffer);
      return { jsMs };
    },
    // Input for the encode-in-WebView alternative (README Faz 2, frame transfer).
    async webCodecs({ width, height }) {
      if (!('VideoEncoder' in window)) return { supported: false };
      const config = { codec: 'avc1.640033', width, height, bitrate: 10_000_000, framerate: 30 };
      return { supported: (await VideoEncoder.isConfigSupported(config)).supported };
    },
  };

  window.gifAnim = {
    handle(id, command) {
      Promise.resolve()
        .then(() => {
          const run = commands[command.cmd];
          if (!run) throw new Error(`unknown command ${command.cmd}`);
          if (contextLost && command.cmd !== 'status' && command.cmd !== 'pause') throw new Error('WebGL context lost; waiting for recovery');
          return run(command);
        })
        .then(
          (result) => send({ id, ok: true, result: result ?? null }),
          (e) => send({ id, ok: false, error: String(e?.stack ?? e) }),
        );
    },
  };
  if (!host && !desktop) addEventListener('message', (event) => {
    if (event.source !== parent || event.origin !== location.origin) return;
    const { id, command } = event.data;
    if (!Number.isInteger(id) || typeof command?.cmd !== 'string') throw new Error('Invalid parent renderer command');
    window.gifAnim.handle(id, command);
  });
}

try {
  start(new Engine(document.getElementById('view')));
  send({ event: 'ready' });
} catch (e) {
  send({ event: 'ready', error: String(e?.stack ?? e) });
}
