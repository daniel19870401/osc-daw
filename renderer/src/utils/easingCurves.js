import { clamp } from './timelineMetrics.js';

const CURVE_DEFINITIONS = [
  { id: 'none', label: 'No Interpolation' },
  { id: 'linear', label: 'Linear Interpolation' },
  { separator: true },
  { id: 'quad-in', label: 'Quadratic Ease-In' },
  { id: 'quad-out', label: 'Quadratic Ease-Out' },
  { id: 'quad-in-out', label: 'Quadratic Ease-In-Out' },
  { separator: true },
  { id: 'cubic-in', label: 'Cubic Ease-In' },
  { id: 'cubic-out', label: 'Cubic Ease-Out' },
  { id: 'cubic-in-out', label: 'Cubic Ease-In-Out' },
  { separator: true },
  { id: 'quart-in', label: 'Quartic Ease-In' },
  { id: 'quart-out', label: 'Quartic Ease-Out' },
  { id: 'quart-in-out', label: 'Quartic Ease-In-Out' },
  { separator: true },
  { id: 'quint-in', label: 'Quintic Ease-In' },
  { id: 'quint-out', label: 'Quintic Ease-Out' },
  { id: 'quint-in-out', label: 'Quintic Ease-In-Out' },
  { separator: true },
  { id: 'sine-in', label: 'Sine Ease-In' },
  { id: 'sine-out', label: 'Sine Ease-Out' },
  { id: 'sine-in-out', label: 'Sine Ease-In-Out' },
  { separator: true },
  { id: 'circ-in', label: 'Circular Ease-In' },
  { id: 'circ-out', label: 'Circular Ease-Out' },
  { id: 'circ-in-out', label: 'Circular Ease-In-Out' },
  { separator: true },
  { id: 'expo-in', label: 'Exponential Ease-In' },
  { id: 'expo-out', label: 'Exponential Ease-Out' },
  { id: 'expo-in-out', label: 'Exponential Ease-In-Out' },
  { separator: true },
  { id: 'elastic-in', label: 'Elastic Ease-In' },
  { id: 'elastic-out', label: 'Elastic Ease-Out' },
  { id: 'elastic-in-out', label: 'Elastic Ease-In-Out' },
  { separator: true },
  { id: 'back-in', label: 'Back Ease-In' },
  { id: 'back-out', label: 'Back Ease-Out' },
  { id: 'back-in-out', label: 'Back Ease-In-Out' },
  { separator: true },
  { id: 'bounce-in', label: 'Bounce Ease-In' },
  { id: 'bounce-out', label: 'Bounce Ease-Out' },
  { id: 'bounce-in-out', label: 'Bounce Ease-In-Out' },
  { separator: true },
  { id: 'smooth', label: 'Smooth' },
];

const CURVE_ALIASES = {
  step: 'none',
  nointerpolation: 'none',
  'no-interpolation': 'none',
  'ease-in': 'cubic-in',
  'ease-out': 'cubic-out',
  'ease-in-out': 'cubic-in-out',
};

const MENU_IDS = new Set(
  CURVE_DEFINITIONS
    .filter((item) => !item.separator)
    .map((item) => item.id)
);

const CURVE_LABEL_MAP = new Map(
  CURVE_DEFINITIONS
    .filter((item) => !item.separator)
    .map((item) => [item.id, item.label])
);

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;
const clamp01 = (value) => clamp(Number(value) || 0, 0, 1);

const easeOutBounce = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) {
    const p = t - 1.5 / d1;
    return n1 * p * p + 0.75;
  }
  if (t < 2.5 / d1) {
    const p = t - 2.25 / d1;
    return n1 * p * p + 0.9375;
  }
  const p = t - 2.625 / d1;
  return n1 * p * p + 0.984375;
};

export const CURVE_MENU_ITEMS = CURVE_DEFINITIONS;

export const normalizeCurveMode = (curve) => {
  const raw = typeof curve === 'string' ? curve.trim().toLowerCase() : '';
  if (!raw) return 'linear';
  if (MENU_IDS.has(raw)) return raw;
  return CURVE_ALIASES[raw] || 'linear';
};

export const formatCurveLabel = (curve) => {
  const mode = normalizeCurveMode(curve);
  return CURVE_LABEL_MAP.get(mode) || 'Linear Interpolation';
};

export const getCurveValueRatio = (ratio, curve = 'linear') => {
  const t = clamp(Number(ratio) || 0, 0, 1);
  const mode = normalizeCurveMode(curve);

  if (mode === 'none') return t >= 1 ? 1 : 0;
  if (mode === 'linear') return t;

  if (mode === 'quad-in') return clamp01(t ** 2);
  if (mode === 'quad-out') return clamp01(1 - ((1 - t) ** 2));
  if (mode === 'quad-in-out') return clamp01(t < 0.5 ? 2 * (t ** 2) : 1 - (((-2 * t + 2) ** 2) / 2));

  if (mode === 'cubic-in') return clamp01(t ** 3);
  if (mode === 'cubic-out') return clamp01(1 - ((1 - t) ** 3));
  if (mode === 'cubic-in-out') return clamp01(t < 0.5 ? 4 * (t ** 3) : 1 - (((-2 * t + 2) ** 3) / 2));

  if (mode === 'quart-in') return clamp01(t ** 4);
  if (mode === 'quart-out') return clamp01(1 - ((1 - t) ** 4));
  if (mode === 'quart-in-out') return clamp01(t < 0.5 ? 8 * (t ** 4) : 1 - (((-2 * t + 2) ** 4) / 2));

  if (mode === 'quint-in') return clamp01(t ** 5);
  if (mode === 'quint-out') return clamp01(1 - ((1 - t) ** 5));
  if (mode === 'quint-in-out') return clamp01(t < 0.5 ? 16 * (t ** 5) : 1 - (((-2 * t + 2) ** 5) / 2));

  if (mode === 'sine-in') return clamp01(1 - Math.cos((t * Math.PI) / 2));
  if (mode === 'sine-out') return clamp01(Math.sin((t * Math.PI) / 2));
  if (mode === 'sine-in-out') return clamp01(-(Math.cos(Math.PI * t) - 1) / 2);

  if (mode === 'circ-in') return clamp01(1 - Math.sqrt(Math.max(0, 1 - (t ** 2))));
  if (mode === 'circ-out') return clamp01(Math.sqrt(Math.max(0, 1 - ((t - 1) ** 2))));
  if (mode === 'circ-in-out') {
    return clamp01(t < 0.5
      ? (1 - Math.sqrt(Math.max(0, 1 - ((2 * t) ** 2)))) / 2
      : (Math.sqrt(Math.max(0, 1 - ((-2 * t + 2) ** 2))) + 1) / 2);
  }

  if (mode === 'expo-in') return clamp01(t === 0 ? 0 : 2 ** (10 * t - 10));
  if (mode === 'expo-out') return clamp01(t === 1 ? 1 : 1 - (2 ** (-10 * t)));
  if (mode === 'expo-in-out') {
    if (t === 0) return 0;
    if (t === 1) return 1;
    return clamp01(t < 0.5
      ? (2 ** (20 * t - 10)) / 2
      : (2 - (2 ** (-20 * t + 10))) / 2);
  }

  if (mode === 'elastic-in') {
    if (t === 0 || t === 1) return t;
    return clamp01(-(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * c4));
  }
  if (mode === 'elastic-out') {
    if (t === 0 || t === 1) return t;
    return clamp01((2 ** (-10 * t)) * Math.sin((t * 10 - 0.75) * c4) + 1);
  }
  if (mode === 'elastic-in-out') {
    if (t === 0 || t === 1) return t;
    if (t < 0.5) {
      return clamp01(-((2 ** (20 * t - 10)) * Math.sin((20 * t - 11.125) * c5)) / 2);
    }
    return clamp01(((2 ** (-20 * t + 10)) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1);
  }

  if (mode === 'back-in') return clamp01(c3 * (t ** 3) - c1 * (t ** 2));
  if (mode === 'back-out') return clamp01(1 + c3 * ((t - 1) ** 3) + c1 * ((t - 1) ** 2));
  if (mode === 'back-in-out') {
    return clamp01(t < 0.5
      ? (((2 * t) ** 2) * (((c2 + 1) * 2 * t) - c2)) / 2
      : ((((2 * t - 2) ** 2) * (((c2 + 1) * (2 * t - 2)) + c2)) + 2) / 2);
  }

  if (mode === 'bounce-in') return clamp01(1 - easeOutBounce(1 - t));
  if (mode === 'bounce-out') return clamp01(easeOutBounce(t));
  if (mode === 'bounce-in-out') {
    return clamp01(t < 0.5
      ? (1 - easeOutBounce(1 - 2 * t)) / 2
      : (1 + easeOutBounce(2 * t - 1)) / 2);
  }

  if (mode === 'smooth') return clamp01(t * t * (3 - 2 * t));

  return t;
};

const curveLutCache = new Map();

const normalizeCurveFps = (fps) => clamp(Math.round(Number(fps) || 30), 8, 240);

export const getCurveLut = (curve, fps = 30) => {
  const mode = normalizeCurveMode(curve);
  const density = normalizeCurveFps(fps);
  const key = `${mode}:${density}`;
  const cached = curveLutCache.get(key);
  if (cached) return cached;
  const values = Array.from({ length: density + 1 }, (_, index) => (
    getCurveValueRatio(index / density, mode)
  ));
  const lut = { mode, density, values };
  curveLutCache.set(key, lut);
  return lut;
};

export const getCurveValueRatioByFps = (ratio, curve = 'linear', fps = 30) => {
  const t = clamp01(ratio);
  const lut = getCurveLut(curve, fps);
  if (!Array.isArray(lut.values) || lut.values.length < 2) {
    return getCurveValueRatio(t, curve);
  }
  const scaled = t * lut.density;
  const indexA = clamp(Math.floor(scaled), 0, lut.density);
  const indexB = clamp(Math.ceil(scaled), 0, lut.density);
  if (indexA === indexB) return lut.values[indexA];
  const mix = scaled - indexA;
  const a = lut.values[indexA];
  const b = lut.values[indexB];
  return clamp01(a + (b - a) * mix);
};
