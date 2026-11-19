// Settings (localStorage), mood themes and breathing-trainer patterns.

const KEY = 'respirovr.';
const DEFAULTS = {
  mood: 0,            // index into MOODS
  source: 'demo',     // demo | touch | mic | ble | ws
  wsUrl: 'ws://192.168.4.1:81',
  mode: 0,            // 0 cascade, 1 flow orbs
  level: 1,           // 0 easy 1 normal 2 hard
  difficulty: 1.0,
  direction: 0,       // 0 inhale raises raw, 1 exhale raises raw
  capacityMl: 3500,
  holdGoal: 3,
  dwell: 1.3,         // gaze dwell seconds (0 = off)
  volume: 0.7,        // master
  ambience: 1, music: 1, cues: 1,
  ipd: 0.063, k1: 0.34, k2: 0.55, zoom: 1.15, shift: 0.0,
  calLo: null, calHi: null,
};
const store = {};
try { Object.assign(store, JSON.parse(localStorage.getItem(KEY + 'v1') || '{}')); } catch (e) { /* storage blocked */ }
export const Settings = new Proxy(store, {
  get(t, k) { return k in t ? t[k] : DEFAULTS[k]; },
  set(t, k, v) {
    t[k] = v;
    try { localStorage.setItem(KEY + 'v1', JSON.stringify(t)); } catch (e) { /* ignore */ }
    return true;
  },
});
export const calibrated = () => Settings.calLo !== null && Settings.calHi !== null;

const c = (r, g, b, a = 1) => [r, g, b, a];
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

/** Five mood worlds. Each one sets the sky, the UI palette and the soundscape. */
export const MOODS = [
  {
    id: 'calm', name: 'Calm Ocean', mood: 'CALM', blurb: 'Slow waves, warm pad, sparse chimes.',
    top: [0.01, 0.10, 0.22], bottom: [0.00, 0.03, 0.08], accent: [0.25, 0.85, 0.85], accent2: [0.4, 0.6, 1.0],
    ocean: 1, stars: 0.4, pattern: 'coherent',
    sound: { chord: [220, 277.18, 329.63, 493.88], noise: 'ocean', noiseGain: 0.5, chimes: 0.18, scale: [0, 2, 4, 7, 9], root: 440, birds: 0 },
  },
  {
    id: 'focus', name: 'Rainy Focus', mood: 'FOCUS', blurb: 'Steady rain and a low drone for concentration.',
    top: [0.06, 0.09, 0.14], bottom: [0.02, 0.03, 0.05], accent: [0.55, 0.78, 1.0], accent2: [0.7, 0.9, 0.95],
    ocean: 0, stars: 0.0, pattern: 'box',
    sound: { chord: [110, 164.81, 220], noise: 'rain', noiseGain: 0.55, chimes: 0.04, scale: [0, 3, 5, 7, 10], root: 392, birds: 0 },
  },
  {
    id: 'sleep', name: 'Aurora Night', mood: 'SLEEP', blurb: 'Deep pad under drifting aurora, no noise.',
    top: [0.03, 0.01, 0.12], bottom: [0.00, 0.00, 0.03], accent: [0.45, 1.0, 0.7], accent2: [0.7, 0.5, 1.0],
    ocean: 0, stars: 1.6, pattern: '478',
    sound: { chord: [98, 146.83, 196, 246.94], noise: 'none', noiseGain: 0, chimes: 0.08, scale: [0, 2, 4, 7, 9], root: 349.23, birds: 0 },
  },
  {
    id: 'energise', name: 'Sunrise Glow', mood: 'ENERGISE', blurb: 'Warm light, bright pad and gentle wind.',
    top: [0.28, 0.10, 0.22], bottom: [0.10, 0.03, 0.04], accent: [1.0, 0.65, 0.3], accent2: [1.0, 0.4, 0.6],
    ocean: 0, stars: 0.5, pattern: 'belly',
    sound: { chord: [174.61, 220, 261.63, 329.63], noise: 'wind', noiseGain: 0.35, chimes: 0.2, scale: [0, 2, 4, 7, 9], root: 523.25, birds: 0 },
  },
  {
    id: 'forest', name: 'Forest Dawn', mood: 'NATURE', blurb: 'Birdsong, soft wind and a green, open pad.',
    top: [0.04, 0.16, 0.12], bottom: [0.01, 0.05, 0.04], accent: [0.6, 1.0, 0.5], accent2: [0.95, 0.9, 0.5],
    ocean: 0, stars: 0.2, pattern: 'pursed',
    sound: { chord: [146.83, 185, 220, 277.18], noise: 'wind', noiseGain: 0.25, chimes: 0.06, scale: [0, 2, 4, 7, 9], root: 587.33, birds: 0.35 },
  },
];

export function theme() {
  const m = MOODS[Settings.mood % MOODS.length];
  const panel = mix(m.bottom.concat(1), [0.1, 0.15, 0.25, 1], 0.35);
  return {
    ...m,
    panel,
    text: c(0.93, 0.97, 1.0), dim: c(0.6, 0.72, 0.82),
    good: c(0.4, 1.0, 0.6), warn: c(1.0, 0.8, 0.3), bad: c(1.0, 0.4, 0.4),
    acc: [...m.accent, 1], acc2: [...m.accent2, 1],
    cyl: [[0.2, 0.8, 1.0, 1], [0.45, 1.0, 0.65, 1], [1.0, 0.55, 0.9, 1]],
  };
}

/** Guided-breathing trainers. Phase list: [label, seconds, target fill at the END of the phase 0..1]. */
export const PATTERNS = {
  coherent: { name: 'Resonance 5.5', desc: 'Coherent breathing, about 5.5 breaths per minute.', phases: [['INHALE', 5.5, 1], ['EXHALE', 5.5, 0]], cycles: 12 },
  box: { name: 'Box 4-4-4-4', desc: 'Inhale, hold, exhale, hold - four seconds each.', phases: [['INHALE', 4, 1], ['HOLD', 4, 1], ['EXHALE', 4, 0], ['HOLD', 4, 0]], cycles: 8 },
  '478': { name: '4-7-8 Wind-down', desc: 'Long hold and a slow exhale. Common before sleep.', phases: [['INHALE', 4, 1], ['HOLD', 7, 1], ['EXHALE', 8, 0]], cycles: 6 },
  belly: { name: 'Belly breathing 4/6', desc: 'Deep diaphragmatic breaths, longer out than in.', phases: [['INHALE', 4, 1], ['EXHALE', 6, 0]], cycles: 10 },
  pursed: { name: 'Pursed-lip 2/4', desc: 'Breathe in through the nose, out slowly through pursed lips.', phases: [['INHALE', 2, 0.8], ['EXHALE', 4, 0]], cycles: 14 },
  hold: { name: 'Breath-hold builder', desc: 'Deep breath in, hold as long as comfortable. Safe: stop any time.', phases: [['INHALE', 4, 1], ['HOLD', 15, 1], ['EXHALE', 6, 0], ['REST', 6, 0]], cycles: 5 },
};
export const PATTERN_ORDER = ['coherent', 'box', '478', 'belly', 'pursed', 'hold'];
