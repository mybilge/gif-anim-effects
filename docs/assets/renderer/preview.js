export class PreviewQuality {
  constructor() { this.maxEdge = null; this.reset(); }

  reset() { this.startedAt = null; this.frames = 0; this.fps = null; }

  sample(now, edge) {
    if (this.startedAt === null) { this.startedAt = now; return false; }
    this.frames++;
    const elapsed = now - this.startedAt;
    if (elapsed < 2000) return false;
    this.fps = this.frames * 1000 / elapsed;
    this.startedAt = now;
    this.frames = 0;
    if (this.fps >= 30 || edge <= 360) return false;
    this.maxEdge = Math.max(360, Math.floor(edge * 0.75));
    return true;
  }
}
