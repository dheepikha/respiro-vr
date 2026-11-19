// Breath input sources (demo / touch / mic / Bluetooth belt / WebSocket) and the BreathMonitor.
import { Settings, calibrated } from './core.js';
import { clamp, lerp } from './math.js';

const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e'; // Nordic UART service
const NUS_TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // notify (device -> phone)

// ------------------------------------------------------------------ sources
/** Each source exposes: label, normalized (already 0..1?), value, ok, update(dt), stop(). */
class DemoSource {
  constructor() { this.label = 'Demo breathing'; this.normalized = true; this.value = 0; this.ok = true; this.t = 0; this.ph = 0; this.rate = 0.2; this.follow = null; }
  update(dt) {
    this.t += dt;
    if (this.follow !== null) {      // guided session: a "perfect" breather following the pacer, with a little noise
      this.value = clamp(this.value + (this.follow - this.value) * Math.min(1, dt / 0.9) + (Math.random() - 0.5) * 0.004, 0, 1);
      return;
    }
    // slowly wandering rate between ~9 and ~16 breaths / min, with an occasional deep breath
    this.rate = 0.2 + 0.05 * Math.sin(this.t * 0.07) + 0.02 * Math.sin(this.t * 0.31);
    this.ph += dt * this.rate * Math.PI * 2;
    const depth = 0.55 + 0.25 * Math.sin(this.t * 0.11) + (Math.sin(this.t * 0.043) > 0.97 ? 0.3 : 0);
    this.value = clamp(0.12 + depth * (0.5 - 0.5 * Math.cos(this.ph)), 0, 1);
  }
  stop() {}
}

class TouchSource {
  constructor() { this.label = 'Touch (hold = inhale)'; this.normalized = true; this.value = 0; this.ok = true; this.down = false; this._d = e => { this.down = true; }; this._u = e => { this.down = false; };
    this._k = e => { if (e.code === 'Space') this.down = e.type === 'keydown'; };
    addEventListener('pointerdown', this._d); addEventListener('pointerup', this._u); addEventListener('pointercancel', this._u);
    addEventListener('keydown', this._k); addEventListener('keyup', this._k); }
  update(dt) { this.value = clamp(this.value + (this.down ? 0.28 : -0.34) * dt, 0, 1); }
  stop() { removeEventListener('pointerdown', this._d); removeEventListener('pointerup', this._u); removeEventListener('pointercancel', this._u); removeEventListener('keydown', this._k); removeEventListener('keyup', this._k); }
}

class MicSource {
  constructor() {
    this.label = 'Microphone (blow)'; this.normalized = true; this.value = 0; this.ok = false; this.err = '';
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }).then(stream => {
      this.stream = stream;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = this.ctx.createMediaStreamSource(stream);
      this.an = this.ctx.createAnalyser(); this.an.fftSize = 1024; src.connect(this.an);
      this.buf = new Float32Array(1024); this.ok = true;
    }).catch(e => { this.err = String(e.message || e); });
  }
  update(dt) {
    if (!this.an) return;
    this.an.getFloatTimeDomainData(this.buf);
    let s = 0; for (let i = 0; i < this.buf.length; i++) s += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(s / this.buf.length);
    const eff = clamp((rms - 0.012) / 0.12, 0, 1);       // blowing strength
    this.value = clamp(this.value + (eff * 0.9 - (1 - eff) * 0.30) * dt, 0, 1);
  }
  stop() { try { this.stream && this.stream.getTracks().forEach(t => t.stop()); this.ctx && this.ctx.close(); } catch (e) { /* ignore */ } }
}

/** Belt over Web Bluetooth (Nordic UART). The ESP32 sketch prints one number per line. */
class BleSource {
  constructor() { this.label = 'Bluetooth belt'; this.normalized = false; this.value = 0; this.ok = false; this.last = 0; this.status = 'not connected'; this.dev = null; this.buf = ''; }
  async connect() {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not available. Use Chrome on Android over HTTPS.');
    this.status = 'choosing device';
    const dev = await navigator.bluetooth.requestDevice({
      filters: [{ services: [NUS] }, { namePrefix: 'Respiro' }, { namePrefix: 'ESP32' }, { namePrefix: 'HC-' }],
      optionalServices: [NUS],
    });
    this.dev = dev;
    dev.addEventListener('gattserverdisconnected', () => { this.ok = false; this.status = 'disconnected'; });
    this.status = 'connecting';
    const server = await dev.gatt.connect();
    const svc = await server.getPrimaryService(NUS);
    const ch = await svc.getCharacteristic(NUS_TX);
    await ch.startNotifications();
    const dec = new TextDecoder();
    ch.addEventListener('characteristicvaluechanged', e => {
      this.buf += dec.decode(e.target.value);
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        const v = parseFloat(line.split(/[,\s;]+/)[0]);
        if (Number.isFinite(v)) { this.value = v; this.last = performance.now(); this.ok = true; }
      }
      if (this.buf.length > 200) this.buf = '';
    });
    this.status = 'connected: ' + (dev.name || 'belt');
  }
  update() { if (this.ok && performance.now() - this.last > 2000) this.status = 'no data'; }
  stop() { try { this.dev && this.dev.gatt.connected && this.dev.gatt.disconnect(); } catch (e) { /* ignore */ } }
}

/** Belt over WebSocket (ESP32 WebSocketsServer). Only works from http:// pages or localhost. */
class WsSource {
  constructor(url) {
    this.label = 'WebSocket belt'; this.normalized = false; this.value = 0; this.ok = false; this.last = 0; this.status = 'connecting';
    try {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => { this.status = 'connected'; };
      this.ws.onclose = () => { this.ok = false; this.status = 'closed'; };
      this.ws.onerror = () => { this.status = 'error (https pages cannot use ws://)'; };
      this.ws.onmessage = e => { const v = parseFloat(String(e.data).split(/[,\s;]+/)[0]); if (Number.isFinite(v)) { this.value = v; this.last = performance.now(); this.ok = true; } };
    } catch (e) { this.status = String(e.message || e); }
  }
  update() { if (this.ok && performance.now() - this.last > 2000) this.status = 'no data'; }
  stop() { try { this.ws && this.ws.close(); } catch (e) { /* ignore */ } }
}

// ------------------------------------------------------------------ monitor
export class BreathMonitor {
  constructor() {
    this.src = null; this.srcKind = '';
    this.ble = new BleSource();           // kept across source switches so the pairing survives
    this.fill = 0; this.volumeMl = 0; this.flow = 0; this.smoothFlow = 0; this.raw = 0; this.rawSmooth = 0;
    this.lo = 0; this.hi = 1; this.autoInit = false;
    this.phase = 'rest';
    this.resetSession();
    this.history = []; this._hT = 0;
  }

  setSource(kind) {
    if (this.src && this.src !== this.ble) this.src.stop();
    this.srcKind = kind; this.autoInit = false;
    if (kind === 'demo') this.src = new DemoSource();
    else if (kind === 'touch') this.src = new TouchSource();
    else if (kind === 'mic') this.src = new MicSource();
    else if (kind === 'ble') this.src = this.ble;
    else if (kind === 'ws') this.src = new WsSource(Settings.wsUrl);
    else this.src = new DemoSource();
    Settings.source = kind;
  }
  /** Guided sessions tell the demo source what to follow (null = free breathing). */
  setGuide(x) { if (this.src && 'follow' in this.src) this.src.follow = x; }
  get status() { return this.src ? (this.src.status || (this.src.ok ? 'ok' : (this.src.err || 'waiting'))) : '-'; }
  get label() { return this.src ? this.src.label : '-'; }

  resetSession() {
    this.sessionTime = 0; this.peakMl = 0; this.bestHold = 0; this.holdT = 0;
    this.lastFvcMl = 0; this.lastFev1Ml = 0; this.lastFev1Ratio = 0;
    this.breaths = []; this.bpm = 0; this._ex = null; this._stillT = 0; this._prevPhase = 'rest';
  }

  /** Normalise the raw sample to 0..1 (calibration -> else slow auto-range). */
  _normalise(raw) {
    const s = this.src;
    if (s.normalized) return raw;
    if (calibrated()) { const lo = Settings.calLo, hi = Settings.calHi; return (raw - lo) / Math.max(1e-6, hi - lo); }
    if (!this.autoInit) { this.lo = raw - 1; this.hi = raw + 1; this.autoInit = true; }
    this.lo = Math.min(this.lo, raw); this.hi = Math.max(this.hi, raw);
    const span = this.hi - this.lo, k = 0.002 * span;               // forget extremes slowly
    if (raw > this.lo + k) this.lo += k * 0.5;
    if (raw < this.hi - k) this.hi -= k * 0.5;
    return (raw - this.lo) / Math.max(1e-6, this.hi - this.lo);
  }

  update(dt) {
    dt = Math.min(dt, 0.1);
    const s = this.src; if (!s) return;
    s.update(dt);
    this.raw = s.value;
    this.rawSmooth += (this.raw - this.rawSmooth) * Math.min(1, dt / 0.12);
    let n = this._normalise(this.raw);
    if (Settings.invert) n = 1 - n;
    n = clamp(n, 0, 1);
    const prevV = this.volumeMl;
    this.fill += (n - this.fill) * Math.min(1, dt / 0.08);
    this.volumeMl = this.fill * Settings.capacityMl;
    const f = dt > 0 ? (this.volumeMl - prevV) / dt : 0;
    this.flow = f;
    this.smoothFlow += (f - this.smoothFlow) * Math.min(1, dt / 0.15);
    this.sessionTime += dt;
    if (this.volumeMl > this.peakMl) this.peakMl = this.volumeMl;

    // phase detection
    const sf = this.smoothFlow;
    let ph;
    if (sf > 140) ph = 'inhale'; else if (sf < -140) ph = 'exhale';
    else { this._stillT += dt; ph = (this._stillT > 0.6 && this.fill > 0.45) ? 'hold' : 'rest'; }
    if (Math.abs(sf) > 140) this._stillT = 0;
    if (ph === 'hold') { this.holdT += dt; this.bestHold = Math.max(this.bestHold, this.holdT); } else this.holdT = 0;
    if (ph === 'inhale' && this._prevPhase !== 'inhale') {
      const t = this.sessionTime; this.breaths.push(t); if (this.breaths.length > 8) this.breaths.shift();
      if (this.breaths.length >= 2) {
        const span = (this.breaths[this.breaths.length - 1] - this.breaths[0]) / (this.breaths.length - 1);
        this.bpm = span > 0.8 ? 60 / span : 0;
      }
    }
    // forced exhale -> FVC / FEV1 estimate
    if (ph === 'exhale' && this._prevPhase !== 'exhale') this._ex = { v0: this.volumeMl, t0: this.sessionTime, v1: null, maxF: 0 };
    if (this._ex) {
      this._ex.maxF = Math.max(this._ex.maxF, -sf);
      if (this._ex.v1 === null && this.sessionTime - this._ex.t0 >= 1) this._ex.v1 = this.volumeMl;
      if (ph !== 'exhale') {
        const e = this._ex, fvc = e.v0 - this.volumeMl;
        if (fvc > 800 && e.maxF > 1500) {
          this.lastFvcMl = fvc; this.lastFev1Ml = e.v1 === null ? fvc : e.v0 - e.v1;
          this.lastFev1Ratio = clamp(this.lastFev1Ml / Math.max(1, fvc), 0, 1);
        }
        this._ex = null;
      }
    }
    this._prevPhase = this.phase = ph;

    this._hT += dt;
    if (this._hT >= 0.05) {
      this._hT = 0; this.history.push([this.fill, clamp(sf / 2500, -1, 1)]);
      if (this.history.length > 400) this.history.shift();
    }
  }

  /** Quality 0..1: fresh data and a usable range. */
  get quality() {
    const s = this.src; if (!s) return 0;
    if (!s.ok) return 0;
    if (s.normalized) return 1;
    if (performance.now() - s.last > 1500) return 0.1;
    if (calibrated()) return 1;
    return clamp((this.hi - this.lo) / Math.max(1e-6, Math.abs(this.hi) * 0.02 + 1), 0.2, 1);
  }
  /** Fill 0..1 that drives the tubes for the trained direction. */
  get driveFill() { return Settings.direction === 0 ? this.fill : 1 - this.fill; }
  /** Flow (mL/s, positive = in the trained direction). */
  get driveFlow() { return Settings.direction === 0 ? this.smoothFlow : -this.smoothFlow; }
}
