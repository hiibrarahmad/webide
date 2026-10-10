// Serial Plotter: parses numeric serial lines and draws them on a canvas.
// Accepted line formats: "a:1 b:2", "a=1,b=2", "1 2 3", "1,2,3" (unnamed values become value1, value2…).

const COLORS = ['#2f9e8f', '#e8833a', '#5b8def', '#d4508f', '#8a6be0', '#c9a227', '#3fb950', '#e5534b'];

export class Plotter {
  constructor(canvas, legend) {
    this.canvas = canvas;
    this.legend = legend;
    this.series = new Map(); // name -> { color, values: number[] }
    this.maxPoints = 400;
    this.paused = false;
    this.dirty = false;
    this.visible = false;
    new ResizeObserver(() => { this.dirty = true; }).observe(canvas);
    const tick = () => {
      if (this.dirty && this.visible) this.draw();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Returns true when the line contained plottable numbers
  addLine(line) {
    if (this.paused) return false;
    const parts = line.trim().split(/[\s,;\t]+/).filter(Boolean);
    if (!parts.length) return false;
    const values = [];
    let unnamed = 0;
    for (const part of parts) {
      const m = part.match(/^(?:([A-Za-z_][\w.\-[\]]*)[:=])?(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)$/i);
      if (!m) return false;
      values.push([m[1] || `value${++unnamed}`, parseFloat(m[2])]);
    }
    for (const [name, v] of values) this.push(name, v);
    return true;
  }

  push(name, value) {
    if (this.paused || !Number.isFinite(value)) return;
    let s = this.series.get(name);
    if (!s) {
      s = { color: COLORS[this.series.size % COLORS.length], values: [] };
      this.series.set(name, s);
      this.renderLegend();
    }
    s.values.push(value);
    if (s.values.length > this.maxPoints) s.values.shift();
    this.dirty = true;
  }

  clear() {
    this.series.clear();
    this.renderLegend();
    this.dirty = true;
  }

  renderLegend() {
    this.legend.innerHTML = '';
    for (const [name, s] of this.series) {
      // Click a legend entry to hide/show that series; the scale follows the visible ones
      const item = document.createElement('button');
      item.className = 'legend-item' + (s.hidden ? ' off' : '');
      item.title = 'Click to hide or show';
      item.innerHTML = '<i></i><span></span>';
      item.firstChild.style.background = s.color;
      item.lastChild.textContent = name;
      item.onclick = () => { s.hidden = !s.hidden; item.classList.toggle('off', s.hidden); this.dirty = true; };
      this.legend.appendChild(item);
    }
  }

  draw() {
    this.dirty = false;
    const { canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border').trim() || '#444';
    const muted = css.getPropertyValue('--muted').trim() || '#888';

    let min = Infinity, max = -Infinity;
    for (const s of this.series.values()) if (!s.hidden) for (const v of s.values) { if (v < min) min = v; if (v > max) max = v; }
    if (!Number.isFinite(min)) {
      ctx.fillStyle = muted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for numbers… print lines like  temp:21.5 humidity:40', w / 2, h / 2);
      return;
    }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08;
    min -= pad; max += pad;

    const left = 52, right = 10, top = 10, bottom = 18;
    const pw = w - left - right, ph = h - top - bottom;
    const y = v => top + ph - ((v - min) / (max - min)) * ph;

    ctx.font = '11px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const v = min + ((max - min) * i) / 5;
      const yy = Math.round(y(v)) + 0.5;
      ctx.strokeStyle = grid;
      ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(w - right, yy); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(Math.abs(v) >= 1000 ? v.toExponential(1) : +v.toFixed(2), left - 6, yy);
    }

    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    for (const s of this.series.values()) {
      const n = s.values.length;
      if (!n || s.hidden) continue;
      ctx.strokeStyle = s.color;
      ctx.beginPath();
      s.values.forEach((v, i) => {
        const x = left + (pw * (this.maxPoints - n + i)) / (this.maxPoints - 1);
        i ? ctx.lineTo(x, y(v)) : ctx.moveTo(x, y(v));
      });
      ctx.stroke();
    }
  }
}
