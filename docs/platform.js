window.gifPlatform = {
  async crop(bytes, crop) {
    if (crop.length !== 4 || crop.some((n) => !Number.isFinite(n) || n < 0 || n > 1) || crop[0] >= crop[2] || crop[1] >= crop[3]) throw new Error(`Invalid crop: ${crop}`);
    const image = await createImageBitmap(new Blob([bytes]));
    try {
      const { width: sw, height: sh } = image;
      if (sw * sh > 100000000) throw new Error(`Source exceeds 100 MP: ${sw}x${sh}`);
      const left = Math.floor(crop[0] * sw), top = Math.floor(crop[1] * sh);
      const right = Math.ceil(crop[2] * sw), bottom = Math.ceil(crop[3] * sh);
      const w = right - left, h = bottom - top, scale = Math.min(1, 4096 / Math.max(w, h));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(w * scale)); canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d'); ctx.drawImage(image, left, top, w, h, 0, 0, canvas.width, canvas.height);
      const pixels = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
      for (let p = 0; p < pixels.length; p += 4) for (let c = 0; c < 3; c++) pixels[p + c] = Math.round(pixels[p + c] * pixels[p + 3] / 255);
      return { pixels, json: JSON.stringify({ width: canvas.width, height: canvas.height, sourceWidth: sw, sourceHeight: sh, crop: [left / sw, top / sh, right / sw, bottom / sh] }) };
    } finally { image.close(); }
  },
  canShare: !!navigator.canShare?.({ files: [new File(['GIF89a'], 'animation.gif', { type: 'image/gif' })] }),
  async fetch(url, limit) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`Download timed out: ${url}`)), 30000);
    try {
      const response = await fetch(url, { redirect: 'error', signal: abort.signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      const reader = response.body.getReader();
      const chunks = []; let length = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit) { await reader.cancel(); throw new Error(`Response exceeds ${limit} bytes: ${url}`); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      return bytes;
    } finally { clearTimeout(timer); }
  },
  download(bytes, name, mime) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const link = document.createElement('a'); link.href = url; link.download = name;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  },
  async share(bytes, name, mime) {
    const files = [new File([bytes], name, { type: mime })];
    if (!navigator.canShare?.({ files })) throw new Error(`File sharing is unavailable: ${mime}`);
    try { await navigator.share({ files }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  },
  async view(bytesPromise, mime) {
    const tab = window.open('about:blank', '_blank');
    if (!tab) throw new Error('Browser blocked the output viewer');
    try {
      const url = URL.createObjectURL(new Blob([await bytesPromise], { type: mime }));
      tab.location = url;
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { tab.close(); throw error; }
  },
  async quota() {
    if (!navigator.storage?.estimate) throw new Error('Storage quota information is unavailable');
    const { usage, quota } = await navigator.storage.estimate();
    return JSON.stringify({ usage, quota, persisted: await navigator.storage.persisted() });
  },
  async persist() { return navigator.storage.persist(); },
};
