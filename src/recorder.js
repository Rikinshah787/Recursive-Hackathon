import { formatViews } from './util.js';

// Records the game into a shareable .webm: vertical 9:16 when the phone frame is on, 16:9 otherwise.
// Trick call-outs and the views counter are burned into the clip as captions.
export class ClipRecorder {
  constructor(sourceCanvas, audio) {
    this.src = sourceCanvas;
    this.audio = audio;
    this.recording = false;
    this.t = 0;
  }

  get supported() {
    return typeof MediaRecorder !== 'undefined' && !!HTMLCanvasElement.prototype.captureStream;
  }

  start(vertical) {
    if (this.recording || !this.supported) return false;
    this.vertical = vertical;
    const c = (this.canvas = document.createElement('canvas'));
    c.width = vertical ? 720 : 1280;
    c.height = vertical ? 1280 : 720;
    this.ctx = c.getContext('2d');
    const stream = c.captureStream(30);
    if (this.audio.ctx) {
      this.dest = this.audio.ctx.createMediaStreamDestination();
      this.audio.master.connect(this.dest);
      for (const tr of this.dest.stream.getAudioTracks()) stream.addTrack(tr);
    }
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) || '';
    this.chunks = [];
    this.rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 9_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.onstop = () => this.save();
    this.rec.start(250);
    this.recording = true;
    this.t = 0;
    return true;
  }

  stop() {
    if (!this.recording) return;
    this.recording = false;
    this.rec.stop();
    if (this.dest) {
      try { this.audio.master.disconnect(this.dest); } catch { /* already disconnected */ }
      this.dest = null;
    }
  }

  save() {
    const blob = new Blob(this.chunks, { type: 'video/webm' });
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = URL.createObjectURL(blob);
    a.download = `roadster-stunt-${stamp}.webm`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 2000);
  }

  // call right after the frame is rendered (the WebGL buffer is still valid then)
  frame(dt, recent, views) {
    if (!this.recording) return;
    this.t += dt;
    const { ctx, canvas } = this;
    const W = canvas.width, H = canvas.height;
    const sw = this.src.width, sh = this.src.height;
    // centre crop to the clip's aspect ratio
    const aspect = W / H;
    let cw = sw, ch = sw / aspect;
    if (ch > sh) { ch = sh; cw = sh * aspect; }
    ctx.drawImage(this.src, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, W, H);

    // captions
    const now = performance.now();
    ctx.textAlign = 'center';
    recent.forEach((r, i) => {
      const age = (now - r.t) / 1000;
      if (age > 1.8) return;
      const a = Math.min(1, age / 0.12) * (age > 1.4 ? 1 - (age - 1.4) / 0.4 : 1);
      ctx.globalAlpha = a;
      const size = Math.round((this.vertical ? 64 : 58) * (i === 0 ? 1 : 0.7));
      ctx.font = `700 ${size}px Rajdhani, Arial, sans-serif`;
      ctx.lineWidth = 8;
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      const y = H * (this.vertical ? 0.3 : 0.28) + i * size * 1.1 - Math.min(age, 1.4) * 14;
      ctx.strokeText(r.title, W / 2, y);
      ctx.fillStyle = r.kind && r.kind.includes('bad') ? '#ff9aa9' : '#ffffff';
      ctx.fillText(r.title, W / 2, y);
    });
    ctx.globalAlpha = 1;
    // watermark + views
    ctx.textAlign = 'left';
    ctx.font = '600 26px Rajdhani, Arial, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillText('ROADSTER FLIGHT', 28, H - 30);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ff2d55';
    ctx.fillText(`♥ ${formatViews(views * 0.083)}   ▶ ${formatViews(views)}`, W - 28, H - 30);
  }
}
