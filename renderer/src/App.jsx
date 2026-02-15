import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import TransportBar from './components/TransportBar.jsx';
import TimelineHeader from './components/TimelineHeader.jsx';
import TrackLane from './components/TrackLane.jsx';
import InspectorPanel from './components/InspectorPanel.jsx';
import InlineColorPicker from './components/InlineColorPicker.jsx';
import NumberInput from './components/NumberInput.jsx';
import nlInteractiveLogo from './assets/nl-interactive-logo.png';
import { createInitialState, projectReducer } from './state/projectStore.js';
import { Decoder as LtcDecoder } from 'linear-timecode';
import {
  clamp,
  TIMELINE_PADDING,
  TIMELINE_WIDTH,
} from './utils/timelineMetrics.js';
import { getCurveValueRatioByFps, normalizeCurveMode } from './utils/easingCurves.js';

const AUDIO_BUFFER_SIZES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const SYNC_FPS_OPTIONS = [
  { id: '23.98', label: '23.98', fps: 23.98, mtcRateCode: 0 },
  { id: '24', label: '24', fps: 24, mtcRateCode: 0 },
  { id: '25', label: '25', fps: 25, mtcRateCode: 1 },
  { id: '29.97', label: '29.97', fps: 29.97, mtcRateCode: 2 },
  { id: '29.97drop', label: '29.97 Drop', fps: 29.97, mtcRateCode: 2 },
  { id: '30', label: '30', fps: 30, mtcRateCode: 3 },
  { id: '30drop', label: '30 Drop', fps: 30, mtcRateCode: 3 },
];
const DEFAULT_SYNC_FPS_ID = '30';
const VIRTUAL_MIDI_INPUT_ID = 'virtual-midi-in';
const VIRTUAL_MIDI_OUTPUT_ID = 'virtual-midi-out';
const APP_MIDI_INPUT_PORT_NAME = 'OSConductor MIDI IN';
const APP_MIDI_OUTPUT_PORT_NAME = 'OSConductor MIDI OUT';
const VIRTUAL_MIDI_INPUT_NAME = APP_MIDI_INPUT_PORT_NAME;
const VIRTUAL_MIDI_OUTPUT_NAME = APP_MIDI_OUTPUT_PORT_NAME;
const DEV_SERVER_PORT = 5170;
const ARTNET_PORT = 6454;
const MAX_AUDIO_CHANNELS = 64;
const MAX_WEB_AUDIO_OUTPUT_CHANNELS = 32;
const DEFAULT_OSC_OUTPUT_ID = 'osc-out-main';
const AUDIO_IMPORT_PROJECT_PADDING_SECONDS = 30;
const COPYRIGHT_YEAR = new Date().getFullYear();
const EMPTY_LIST = Object.freeze([]);

const resolveSyncFps = (syncFpsId) => {
  const found = SYNC_FPS_OPTIONS.find((item) => item.id === syncFpsId);
  return found || SYNC_FPS_OPTIONS.find((item) => item.id === DEFAULT_SYNC_FPS_ID) || SYNC_FPS_OPTIONS[0];
};

const createMtcState = () => ({
  parts: Array(8).fill(0),
  mask: 0,
  lastType: -1,
  sequenceValid: false,
  lastDecodedSeconds: null,
  lastDecodedAt: 0,
});

const MTC_PLL_ACQUIRE_THRESHOLD_SECONDS = 0.4;
const MTC_PLL_REJECT_THRESHOLD_SECONDS = 1.5;
const MTC_PLL_KP = 0.22;
const MTC_PLL_KI = 0.012;
const MTC_PLL_FREQUENCY_MIN = 0.95;
const MTC_PLL_FREQUENCY_MAX = 1.05;
const MTC_QUARTER_FRAME_COMPENSATION_FRAMES = 2;

const createMtcPllState = () => ({
  locked: false,
  phase: 0,
  frequency: 1,
  lastUpdateAt: 0,
});

const predictMtcPllTime = (pll, now) => {
  if (!pll?.locked) return null;
  const dt = Math.max((now - (pll.lastUpdateAt || now)) / 1000, 0);
  return pll.phase + pll.frequency * dt;
};

const toFrameBase = (fps) => Math.max(Math.round(Number(fps) || 30), 1);

const secondsToHmsfParts = (seconds, fps) => {
  const frameBase = toFrameBase(fps);
  const totalFrames = Math.max(Math.round((Number(seconds) || 0) * frameBase), 0);
  const frames = totalFrames % frameBase;
  const totalSeconds = Math.floor(totalFrames / frameBase);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  return { hours, minutes: mins, seconds: secs, frames };
};

const hmsfPartsToSeconds = (hours, minutes, seconds, frames, fps) => {
  const frameBase = toFrameBase(fps);
  const safeHours = Math.max(Number(hours) || 0, 0);
  const safeMinutes = clamp(Number(minutes) || 0, 0, 59);
  const safeSeconds = clamp(Number(seconds) || 0, 0, 59);
  const safeFrames = clamp(Number(frames) || 0, 0, frameBase - 1);
  return safeHours * 3600 + safeMinutes * 60 + safeSeconds + safeFrames / frameBase;
};

const formatHmsfTimecode = (seconds, fps) => {
  const { hours, minutes, seconds: secs, frames } = secondsToHmsfParts(seconds, fps);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(frames)}`;
};

const parseHmsfTimecode = (value, fps) => {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return null;
  const match = /^(\d+):([0-5]?\d):([0-5]?\d)(?:[.:](\d{1,2}))?$/.exec(input);
  if (!match) return null;
  const frameBase = toFrameBase(fps);
  const hours = Math.max(Number(match[1]) || 0, 0);
  const minutes = clamp(Number(match[2]) || 0, 0, 59);
  const seconds = clamp(Number(match[3]) || 0, 0, 59);
  const frames = clamp(Number(match[4] ?? 0) || 0, 0, frameBase - 1);
  return hmsfPartsToSeconds(hours, minutes, seconds, frames, fps);
};

const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const formatMidiNoteLabel = (value) => {
  const note = clamp(Math.round(Number(value) || 0), 0, 127);
  const name = MIDI_NOTE_NAMES[note % 12] || 'C';
  const octave = Math.floor(note / 12) - 2;
  return `${name}${octave}`;
};

const toMidiCcValue = (value, fallback = 0) => {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return clamp(Math.round(safe), 0, 127);
};

const toDmxValue = (value, fallback = 0) => {
  const numeric = Number(value);
  const safe = Number.isFinite(numeric) ? numeric : fallback;
  return clamp(Math.round(safe), 0, 255);
};

const normalizeOscAddressPath = (value, fallback = '/osc/value') => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return fallback;
  if (raw.startsWith('/')) return raw;
  return `/${raw}`;
};

const HEX_COLOR_RE = /^#([0-9a-f]{6})$/i;

const clampByte = (value) => clamp(Math.round(Number(value) || 0), 0, 255);

const parseHexColor = (value, fallback = '#000000') => {
  const input = typeof value === 'string' && HEX_COLOR_RE.test(value) ? value : fallback;
  const match = HEX_COLOR_RE.exec(input);
  const hex = match ? match[1] : '000000';
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

const rgbToHex = (rgb) => (
  `#${[rgb.r, rgb.g, rgb.b].map((value) => clampByte(value).toString(16).padStart(2, '0')).join('')}`
);

const lerpColor = (from, to, t) => {
  const ratio = clamp(Number(t) || 0, 0, 1);
  return {
    r: clampByte(from.r + (to.r - from.r) * ratio),
    g: clampByte(from.g + (to.g - from.g) * ratio),
    b: clampByte(from.b + (to.b - from.b) * ratio),
  };
};

const safeDisconnectAudioNode = (node) => {
  if (!node || typeof node.disconnect !== 'function') return;
  try {
    node.disconnect();
  } catch (error) {
    // Ignore node disconnect errors.
  }
};

const normalizeAudioDeviceName = (value) => (
  typeof value === 'string'
    ? value
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/^[^:]+:\s*/g, '')
      .replace(/\b(virtual|default|output|device)\b/g, ' ')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
    : ''
);

const rgbToRgbw = (rgb) => {
  const white = Math.min(rgb.r, rgb.g, rgb.b);
  return {
    r: clampByte(rgb.r - white),
    g: clampByte(rgb.g - white),
    b: clampByte(rgb.b - white),
    w: clampByte(white),
  };
};

const getColorTrackConfig = (track) => {
  if (!track) return null;
  if (track.kind === 'dmx-color') return track.dmxColor || {};
  if (track.kind === 'osc-color') return track.oscColor || {};
  return null;
};

const colorTrackNodeHex = (track, node) => {
  if (!track || (track.kind !== 'dmx-color' && track.kind !== 'osc-color')) return '#000000';
  if (node && typeof node.c === 'string' && HEX_COLOR_RE.test(node.c)) return node.c.toLowerCase();
  return colorTrackValueToHex(track, node?.v ?? track.default);
};

const sampleColorTrackHexAtTime = (track, time) => {
  if (!track || (track.kind !== 'dmx-color' && track.kind !== 'osc-color')) return '#000000';
  const nodes = Array.isArray(track.nodes) ? track.nodes : [];
  if (!nodes.length) return colorTrackValueToHex(track, track.default);
  const sorted = [...nodes].sort((a, b) => a.t - b.t);
  if (time <= sorted[0].t) return colorTrackNodeHex(track, sorted[0]);
  if (time >= sorted[sorted.length - 1].t) return colorTrackNodeHex(track, sorted[sorted.length - 1]);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time < a.t || time > b.t) continue;
    if (Math.abs(b.t - a.t) < 1e-9) return colorTrackNodeHex(track, b);
    const ratio = clamp((time - a.t) / (b.t - a.t), 0, 1);
    const aRgb = parseHexColor(colorTrackNodeHex(track, a), '#000000');
    const bRgb = parseHexColor(colorTrackNodeHex(track, b), '#000000');
    return rgbToHex(lerpColor(aRgb, bRgb, ratio));
  }
  return colorTrackNodeHex(track, sorted[sorted.length - 1]);
};

const resolveDmxColorWrites = (track, time) => {
  if (track.kind !== 'dmx-color') return [];
  const cfg = track.dmxColor || {};
  const fixtureType = cfg.fixtureType === 'rgbw' || cfg.fixtureType === 'mapping' ? cfg.fixtureType : 'rgb';
  const mappingChannels = Number(cfg.mappingChannels) === 3 ? 3 : 4;
  const start = clamp(Math.round(Number(cfg.channelStart) || 1), 1, 512);
  const hexColor = sampleColorTrackHexAtTime(track, time);
  const rgb = parseHexColor(hexColor, '#000000');
  const rgbw = rgbToRgbw(rgb);
  const writes = [];
  if (fixtureType === 'rgb') {
    writes.push([start, rgb.r], [start + 1, rgb.g], [start + 2, rgb.b]);
    return writes;
  }
  if (fixtureType === 'rgbw') {
    writes.push([start, rgbw.r], [start + 1, rgbw.g], [start + 2, rgbw.b], [start + 3, rgbw.w]);
    return writes;
  }
  const mapping = cfg.mapping || {};
  writes.push(
    [start + (clamp(Math.round(Number(mapping.r) || 1), 1, 512) - 1), mappingChannels === 3 ? rgb.r : rgbw.r],
    [start + (clamp(Math.round(Number(mapping.g) || 2), 1, 512) - 1), mappingChannels === 3 ? rgb.g : rgbw.g],
    [start + (clamp(Math.round(Number(mapping.b) || 3), 1, 512) - 1), mappingChannels === 3 ? rgb.b : rgbw.b],
  );
  if (mappingChannels === 4) {
    writes.push([start + (clamp(Math.round(Number(mapping.w) || 4), 1, 512) - 1), rgbw.w]);
  }
  return writes;
};

const resolveOscColorWrites = (track, time) => {
  if (!track || track.kind !== 'osc-color') return [];
  const cfg = track.oscColor || {};
  const fixtureType = cfg.fixtureType === 'rgbw' ? 'rgbw' : 'rgb';
  const outputRange = cfg.outputRange === 'unit' ? 'unit' : 'byte';
  const baseAddressRaw = typeof track.oscAddress === 'string' && track.oscAddress.trim()
    ? track.oscAddress.trim()
    : '/osc/color';
  const baseAddress = baseAddressRaw.replace(/\/+$/, '') || '/osc/color';
  const hexColor = sampleColorTrackHexAtTime(track, time);
  const rgb = parseHexColor(hexColor, '#000000');
  const rgbw = rgbToRgbw(rgb);
  const rawValues = fixtureType === 'rgbw'
    ? [rgbw.r, rgbw.g, rgbw.b, rgbw.w]
    : [rgb.r, rgb.g, rgb.b];
  const values = outputRange === 'unit'
    ? rawValues.map((value) => Math.round((clamp(Number(value) || 0, 0, 255) / 255) * 100) / 100)
    : rawValues.map((value) => clamp(Math.round(Number(value) || 0), 0, 255));
  return [{ address: baseAddress, values }];
};

const colorTrackValueToHex = (track, value) => {
  const cfg = getColorTrackConfig(track);
  if (!cfg) return '#000000';
  const min = Number.isFinite(track.min) ? track.min : 0;
  const max = Number.isFinite(track.max) ? track.max : 255;
  const ratio = clamp((Number(value) - min) / Math.max(max - min, 0.000001), 0, 1);
  const from = parseHexColor(cfg.gradientFrom, '#000000');
  const to = parseHexColor(cfg.gradientTo, '#000000');
  return rgbToHex(lerpColor(from, to, ratio));
};

const colorTrackHexToValue = (track, hexColor) => {
  const cfg = getColorTrackConfig(track);
  if (!cfg) return Number(track?.default) || 0;
  const from = parseHexColor(cfg.gradientFrom, '#000000');
  const to = parseHexColor(cfg.gradientTo, '#000000');
  const target = parseHexColor(hexColor, '#000000');
  const dr = to.r - from.r;
  const dg = to.g - from.g;
  const db = to.b - from.b;
  const length2 = dr * dr + dg * dg + db * db;
  const ratio = length2 < 1e-6
    ? 0
    : clamp(
      ((target.r - from.r) * dr + (target.g - from.g) * dg + (target.b - from.b) * db) / length2,
      0,
      1
    );
  const min = Number.isFinite(track.min) ? track.min : 0;
  const max = Number.isFinite(track.max) ? track.max : 255;
  return clamp(min + (max - min) * ratio, min, max);
};

const getOscArrayValueCount = (track) => (
  clamp(Math.round(Number(track?.oscArray?.valueCount) || 5), 1, 20)
);

const normalizeOscArrayNodeValues = (track, node) => {
  const count = getOscArrayValueCount(track);
  const min = Number.isFinite(track?.min) ? Number(track.min) : 0;
  const max = Number.isFinite(track?.max) ? Number(track.max) : 1;
  const fallback = clamp(Number(node?.v ?? track?.default ?? 0) || 0, min, max);
  const raw = Array.isArray(node?.arr) ? node.arr : [];
  return Array.from({ length: count }, (_, index) => (
    clamp(Number(raw[index] ?? fallback) || 0, min, max)
  ));
};

const getOscSendValueType = (track) => (track?.oscValueType === 'int' ? 'int' : 'float');

const formatOscOutputScalar = (value, valueType) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (valueType === 'int') return Math.round(numeric);
  return Math.round(numeric * 100) / 100;
};

const formatOscOutputArray = (values, valueType) => {
  const raw = Array.isArray(values) ? values : [];
  return raw.map((value) => formatOscOutputScalar(value, valueType));
};

const normalizeOscOutputName = (value, index = 0) => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return `OSC Output ${String(index + 1).padStart(2, '0')}`;
};

const normalizeOscOutputHost = (value) => (
  typeof value === 'string' && value.trim()
    ? value.trim()
    : '127.0.0.1'
);

const normalizeOscOutputPort = (value, fallback = 9000) => (
  clamp(Math.round(Number(value) || fallback), 1, 65535)
);

const normalizeOscOutputsForUi = (oscSettings) => {
  const raw = Array.isArray(oscSettings?.outputs) ? oscSettings.outputs : [];
  const fallbackHost = normalizeOscOutputHost(oscSettings?.host);
  const fallbackPort = normalizeOscOutputPort(oscSettings?.port, 9000);
  const normalized = [];
  const ids = new Set();
  raw.forEach((entry, index) => {
    const source = entry || {};
    let id =
      typeof source.id === 'string' && source.id.trim()
        ? source.id.trim()
        : `osc-out-${index + 1}`;
    if (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    normalized.push({
      id,
      name: normalizeOscOutputName(source.name, index),
      host: normalizeOscOutputHost(source.host || fallbackHost),
      port: normalizeOscOutputPort(source.port, fallbackPort),
    });
  });
  if (normalized.length) return normalized;
  return [{
    id: DEFAULT_OSC_OUTPUT_ID,
    name: 'Main',
    host: fallbackHost,
    port: fallbackPort,
  }];
};

const sampleOscArrayTrackValues = (track, time, curveFps = 30) => {
  const count = getOscArrayValueCount(track);
  const min = Number.isFinite(track?.min) ? Number(track.min) : 0;
  const max = Number.isFinite(track?.max) ? Number(track.max) : 1;
  const defaultValue = clamp(Number(track?.default ?? 0) || 0, min, max);
  const fallback = Array.from({ length: count }, () => defaultValue);
  if (!track || track.kind !== 'osc-array') return fallback;
  const nodes = Array.isArray(track.nodes) ? track.nodes : [];
  if (!nodes.length) return fallback;
  const sorted = [...nodes].sort((a, b) => a.t - b.t);
  if (time <= sorted[0].t) return normalizeOscArrayNodeValues(track, sorted[0]);
  if (time >= sorted[sorted.length - 1].t) return normalizeOscArrayNodeValues(track, sorted[sorted.length - 1]);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time < a.t || time > b.t) continue;
    const aValues = normalizeOscArrayNodeValues(track, a);
    const bValues = normalizeOscArrayNodeValues(track, b);
    if (Math.abs(b.t - a.t) < 1e-9) return bValues;
    const ratio = getCurveValueRatioByFps((time - a.t) / (b.t - a.t), a.curve, curveFps);
    return aValues.map((value, index) => clamp(value + (bValues[index] - value) * ratio, min, max));
  }
  return normalizeOscArrayNodeValues(track, sorted[sorted.length - 1]);
};

const DEFAULT_OSC_3D_BOUNDS = Object.freeze({
  xMin: -1,
  xMax: 1,
  yMin: -1,
  yMax: 1,
  zMin: -1,
  zMax: 1,
});

const normalizeOsc3dBounds = (trackOrSettings) => {
  const raw =
    trackOrSettings?.osc3d?.bounds
    || trackOrSettings?.bounds
    || trackOrSettings
    || {};
  const normalizeAxis = (minValue, maxValue, fallbackMin, fallbackMax) => {
    const min = Number.isFinite(Number(minValue)) ? Number(minValue) : fallbackMin;
    const max = Number.isFinite(Number(maxValue)) ? Number(maxValue) : fallbackMax;
    if (min <= max) return { min, max };
    return { min: max, max: min };
  };
  const x = normalizeAxis(raw.xMin, raw.xMax, DEFAULT_OSC_3D_BOUNDS.xMin, DEFAULT_OSC_3D_BOUNDS.xMax);
  const y = normalizeAxis(raw.yMin, raw.yMax, DEFAULT_OSC_3D_BOUNDS.yMin, DEFAULT_OSC_3D_BOUNDS.yMax);
  const z = normalizeAxis(raw.zMin, raw.zMax, DEFAULT_OSC_3D_BOUNDS.zMin, DEFAULT_OSC_3D_BOUNDS.zMax);
  return {
    xMin: x.min,
    xMax: x.max,
    yMin: y.min,
    yMax: y.max,
    zMin: z.min,
    zMax: z.max,
  };
};

const getOsc3dDefaultValues = (bounds) => ([
  (bounds.xMin + bounds.xMax) * 0.5,
  (bounds.yMin + bounds.yMax) * 0.5,
  (bounds.zMin + bounds.zMax) * 0.5,
]);

const normalizeOsc3dNodeValues = (track, node) => {
  const bounds = normalizeOsc3dBounds(track);
  const fallback = getOsc3dDefaultValues(bounds);
  const raw = Array.isArray(node?.arr) ? node.arr : [];
  const yFromValue = Number.isFinite(Number(node?.v)) ? Number(node.v) : fallback[1];
  return [
    clamp(Number.isFinite(Number(raw[0])) ? Number(raw[0]) : fallback[0], bounds.xMin, bounds.xMax),
    clamp(Number.isFinite(Number(raw[1])) ? Number(raw[1]) : yFromValue, bounds.yMin, bounds.yMax),
    clamp(Number.isFinite(Number(raw[2])) ? Number(raw[2]) : fallback[2], bounds.zMin, bounds.zMax),
  ];
};

const sampleOsc3dTrackValues = (track, time, curveFps = 30) => {
  const bounds = normalizeOsc3dBounds(track);
  const fallback = getOsc3dDefaultValues(bounds);
  if (!track || track.kind !== 'osc-3d') return fallback;
  const nodes = Array.isArray(track.nodes) ? track.nodes : [];
  if (!nodes.length) return fallback;
  const sorted = [...nodes].sort((a, b) => a.t - b.t);
  if (time <= sorted[0].t) return normalizeOsc3dNodeValues(track, sorted[0]);
  if (time >= sorted[sorted.length - 1].t) return normalizeOsc3dNodeValues(track, sorted[sorted.length - 1]);
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (time < a.t || time > b.t) continue;
    const aValues = normalizeOsc3dNodeValues(track, a);
    const bValues = normalizeOsc3dNodeValues(track, b);
    if (Math.abs(b.t - a.t) < 1e-9) return bValues;
    const ratio = getCurveValueRatioByFps((time - a.t) / (b.t - a.t), a.curve, curveFps);
    return [
      clamp(aValues[0] + (bValues[0] - aValues[0]) * ratio, bounds.xMin, bounds.xMax),
      clamp(aValues[1] + (bValues[1] - aValues[1]) * ratio, bounds.yMin, bounds.yMax),
      clamp(aValues[2] + (bValues[2] - aValues[2]) * ratio, bounds.zMin, bounds.zMax),
    ];
  }
  return normalizeOsc3dNodeValues(track, sorted[sorted.length - 1]);
};

const OSC3D_CAMERA_DEFAULT = Object.freeze({
  yaw: 34,
  pitch: 18,
  zoom: 1,
});

const OSC3D_CUBE_VERTICES = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
];

const OSC3D_CUBE_EDGES = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

const OSC3D_AXIS_DEFINITIONS = [
  { id: 'x', label: 'X', color: 'rgba(255, 100, 100, 0.95)', vector: [1, 0, 0] },
  { id: 'y', label: 'Y', color: 'rgba(100, 255, 120, 0.95)', vector: [0, 1, 0] },
  { id: 'z', label: 'Z', color: 'rgba(110, 160, 255, 0.95)', vector: [0, 0, 1] },
];

const rotateOsc3dVector = (vector, yawDeg, pitchDeg) => {
  const [x, y, z] = vector;
  const yaw = (Number(yawDeg) || 0) * (Math.PI / 180);
  const pitch = (Number(pitchDeg) || 0) * (Math.PI / 180);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);

  const x1 = x * cosY - z * sinY;
  const z1 = x * sinY + z * cosY;
  const y1 = y * cosP - z1 * sinP;
  const z2 = y * sinP + z1 * cosP;
  return { x: x1, y: y1, z: z2 };
};

const projectOsc3dVector = (vector, camera) => {
  const rotated = rotateOsc3dVector(vector, camera?.yaw, camera?.pitch);
  const zoom = clamp(Number(camera?.zoom) || 1, 0.4, 3.2);
  const perspective = 2.8;
  const depth = perspective / (perspective + rotated.z + 2.1);
  const scale = 36 * zoom * depth;
  return {
    x: 50 + rotated.x * scale,
    y: 50 - rotated.y * scale,
    depth,
  };
};

const createOsc3dPreviewGeometry = (ratios, camera) => {
  const nx = clamp((Number(ratios?.x) || 0) * 2 - 1, -1, 1);
  const ny = clamp((Number(ratios?.y) || 0) * 2 - 1, -1, 1);
  const nz = clamp((Number(ratios?.z) || 0) * 2 - 1, -1, 1);
  const projectedVertices = OSC3D_CUBE_VERTICES.map((vertex) => projectOsc3dVector(vertex, camera));
  const edges = OSC3D_CUBE_EDGES.map(([from, to], index) => ({
    id: `edge-${index}`,
    from: projectedVertices[from],
    to: projectedVertices[to],
    depth: (projectedVertices[from].depth + projectedVertices[to].depth) * 0.5,
  })).sort((a, b) => a.depth - b.depth);
  const point = projectOsc3dVector([nx, ny, nz], camera);
  const axisOrigin = projectOsc3dVector([0, 0, 0], camera);
  const axes = OSC3D_AXIS_DEFINITIONS.map((axis) => {
    const [vx, vy, vz] = axis.vector;
    const tip = projectOsc3dVector([vx * 0.3, vy * 0.3, vz * 0.3], camera);
    const labelPos = projectOsc3dVector([vx * 0.42, vy * 0.42, vz * 0.42], camera);
    return {
      ...axis,
      from: axisOrigin,
      tip,
      labelPos,
      depth: tip.depth,
    };
  }).sort((a, b) => a.depth - b.depth);
  return { edges, point, axes };
};

const OSC3D_MONITOR_WINDOW_NAME = 'osconductor-osc3d-monitor';
const OSC3D_MONITOR_HTML = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>3D OSC Monitor</title>
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      padding: 12px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans TC", sans-serif;
      background: #0b111c;
      color: #d5e2ff;
    }
    .panel {
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: 100%;
    }
    .title {
      font-size: 12px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #9fb6df;
    }
    .track {
      font-size: 18px;
      font-weight: 700;
      color: #e9f3ff;
      line-height: 1.2;
    }
    .meta {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
      font-size: 12px;
      color: #a9bfdf;
    }
    .xyz {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      font-size: 13px;
      color: #7df4e0;
    }
    .stage-wrap {
      position: relative;
      flex: 1;
      min-height: 280px;
      border-radius: 12px;
      border: 1px solid rgba(115, 156, 220, 0.45);
      background: radial-gradient(circle at 30% 18%, rgba(38, 61, 99, 0.4), rgba(10, 14, 22, 0.95));
      overflow: hidden;
    }
    .stage-wrap::before {
      content: "";
      position: absolute;
      inset: 0;
      background:
        repeating-linear-gradient(to right, transparent 0, transparent 23px, rgba(95, 169, 255, 0.08) 23px, rgba(95, 169, 255, 0.08) 24px),
        repeating-linear-gradient(to bottom, transparent 0, transparent 23px, rgba(95, 169, 255, 0.08) 23px, rgba(95, 169, 255, 0.08) 24px);
      pointer-events: none;
    }
    .stage-hit {
      position: absolute;
      inset: 0;
      cursor: grab;
      touch-action: none;
    }
    .stage-hit.dragging {
      cursor: grabbing;
    }
    .stage {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    .axis-line {
      stroke-width: 1.2;
      vector-effect: non-scaling-stroke;
      opacity: 0.95;
    }
    .axis-label {
      font-size: 4.2px;
      font-weight: 700;
      paint-order: stroke;
      stroke: rgba(6, 10, 16, 0.92);
      stroke-width: 1px;
      vector-effect: non-scaling-stroke;
      dominant-baseline: middle;
      text-anchor: middle;
      pointer-events: none;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="title">3D OSC Monitor</div>
    <div class="track" id="osc3d-track-name">No Track</div>
    <div class="meta">
      <span id="osc3d-timecode">00:00:00.00</span>
      <span id="osc3d-range">X -1~1 · Y -1~1 · Z -1~1</span>
    </div>
    <div class="xyz" id="osc3d-values">X 0.00  Y 0.00  Z 0.00</div>
    <div class="stage-wrap">
      <div id="osc3d-stage-hit" class="stage-hit">
        <svg id="osc3d-stage" class="stage" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
          <g id="osc3d-axis"></g>
          <g id="osc3d-edges"></g>
          <circle id="osc3d-point" cx="50" cy="50" r="3" fill="rgba(255,180,88,0.96)" stroke="rgba(14,18,28,0.85)" stroke-width="0.7"></circle>
        </svg>
      </div>
    </div>
  </div>
</body>
</html>`;

export default function App() {
  const [state, dispatch] = useReducer(projectReducer, undefined, createInitialState);
  const { project, selectedTrackId, historyPast, historyFuture } = state;
  const [isPlaying, setIsPlaying] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [playhead, setPlayhead] = useState(project.view.start);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHelpOpen, setIsHelpOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState('project');
  const [isCompositionsVisible, setIsCompositionsVisible] = useState(true);
  const [isInspectorVisible, setIsInspectorVisible] = useState(true);
  const [editingCompositionId, setEditingCompositionId] = useState(null);
  const [editingCompositionName, setEditingCompositionName] = useState('');
  const [dragCompositionId, setDragCompositionId] = useState(null);
  const [compositionDropTarget, setCompositionDropTarget] = useState(null);
  const [isAddTrackMenuOpen, setIsAddTrackMenuOpen] = useState(false);
  const [addTrackMenuMode, setAddTrackMenuMode] = useState('single');
  const [multiAddDialog, setMultiAddDialog] = useState(null);
  const [dragTrackId, setDragTrackId] = useState(null);
  const [dragTrackIds, setDragTrackIds] = useState([]);
  const [dropTarget, setDropTarget] = useState(null);
  const [nameFocusToken, setNameFocusToken] = useState(0);
  const [editingTrackNameId, setEditingTrackNameId] = useState(null);
  const [editingTrackName, setEditingTrackName] = useState('');
  const [selectedNodeContext, setSelectedNodeContext] = useState({ trackId: null, nodeIds: [] });
  const selectedNodeIdsByTrackRef = useRef(new Map());
  const [selectedNodeIdsByTrack, setSelectedNodeIdsByTrack] = useState({});
  const [trackEditMarquee, setTrackEditMarquee] = useState(null);
  const trackEditMarqueeRef = useRef(null);
  const [editingNode, setEditingNode] = useState(null);
  const [osc3dCamera, setOsc3dCamera] = useState({ ...OSC3D_CAMERA_DEFAULT });
  const osc3dCameraDragRef = useRef(null);
  const [editingCue, setEditingCue] = useState(null);
  const [editingLoopRange, setEditingLoopRange] = useState(null);
  const [editingAudioClip, setEditingAudioClip] = useState(null);
  const [audioChannelMapTrackId, setAudioChannelMapTrackId] = useState(null);
  const [audioChannelMapDraft, setAudioChannelMapDraft] = useState(null);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [audioInputs, setAudioInputs] = useState([]);
  const [audioOutputChannelCaps, setAudioOutputChannelCaps] = useState({});
  const [audioOutputError, setAudioOutputError] = useState(null);
  const [nativeAudioStatus, setNativeAudioStatus] = useState({
    available: false,
    streamOpen: false,
    streamRunning: false,
    api: null,
    error: null,
  });
  const [nativeAudioDevices, setNativeAudioDevices] = useState([]);
  const [midiStatus, setMidiStatus] = useState({
    inputName: VIRTUAL_MIDI_INPUT_NAME,
    outputName: VIRTUAL_MIDI_OUTPUT_NAME,
    error: null,
  });
  const [midiDevices, setMidiDevices] = useState({ inputs: [], outputs: [] });
  const [timelineWidth, setTimelineWidth] = useState(TIMELINE_WIDTH);
  const [selectedTrackIds, setSelectedTrackIds] = useState(
    selectedTrackId ? [selectedTrackId] : []
  );
  const selectionAnchorTrackIdRef = useRef(selectedTrackId ?? null);
  const [isUiResizing, setIsUiResizing] = useState(false);
  const [oscListenState, setOscListenState] = useState({
    status: 'stopped',
    port: Number(project.osc?.listenPort) || 8999,
    error: null,
    lastAddress: null,
    lastAt: null,
  });
  const lastTickRef = useRef(null);
  const playheadRef = useRef(0);
  const isPlayingRef = useRef(false);
  const syncModeRef = useRef(project.timebase?.sync || 'Internal');
  const syncFpsRef = useRef(resolveSyncFps(project.timebase?.syncFps).fps);
  const projectCurveFpsRef = useRef(project.timebase?.fps || 30);
  const projectLengthRef = useRef(project.view.length || 0);
  const projectTracksRef = useRef(project.tracks || []);
  const compositionsRef = useRef(project.compositions || []);
  const activeCompositionIdRef = useRef(project.activeCompositionId || null);
  const compositionPlayheadsRef = useRef(new Map());
  const cuesRef = useRef(project.cues || []);
  const viewRef = useRef(project.view);
  const oscPendingPreviewRef = useRef(new Map());
  const oscLatestByAddressRef = useRef(new Map());
  const oscRecordQueueRef = useRef([]);
  const oscDroppedRef = useRef(0);
  const oscMetaRef = useRef({ lastAddress: null, lastAt: null, dirty: false, lastUiSyncAt: 0 });
  const internalClockRef = useRef({ running: false, startPerf: 0, startPlayhead: 0, startWallMs: 0 });
  const mtcStateRef = useRef(createMtcState());
  const mtcPllRef = useRef(createMtcPllState());
  const mtcFollowTimeoutRef = useRef(null);
  const ltcFollowTimeoutRef = useRef(null);
  const ltcStreamRef = useRef(null);
  const ltcContextRef = useRef(null);
  const ltcSourceRef = useRef(null);
  const ltcProcessorRef = useRef(null);
  const ltcDecoderRef = useRef(null);
  const fileInputRef = useRef(null);
  const clipboardRef = useRef(null);
  const audioElementsRef = useRef(new Map());
  const audioUrlRef = useRef(new Map());
  const pendingSeekRef = useRef(new Map());
  const audioContextRef = useRef(null);
  const audioRoutingRef = useRef(new Map());
  const audioOutputProbeRef = useRef(new Map());
  const timelineWidthHostRef = useRef(null);
  const trackLanesPanelRef = useRef(null);
  const resizeHoldUntilRef = useRef(0);
  const resizeIdleTimerRef = useRef(null);
  const midiAccessRef = useRef(null);
  const midiInputRef = useRef(null);
  const midiOutputRef = useRef(null);
  const midiTrackRuntimeRef = useRef(new Map());
  const midiNoteRuntimeRef = useRef(new Map());
  const artNetSequenceRef = useRef(new Map());
  const oscFlagPlaybackRef = useRef({ lastTime: null });
  const nativeAudioConfigKeyRef = useRef('');
  const nativeAudioMixKeyRef = useRef('');
  const osc3dMonitorWindowsRef = useRef(new Map());
  const [audioWaveforms, setAudioWaveforms] = useState({});

  const compositions = useMemo(
    () => (Array.isArray(project.compositions) ? project.compositions : []),
    [project.compositions]
  );
  const activeCompositionId = project.activeCompositionId || compositions[0]?.id || null;
  const getRememberedCompositionPlayhead = useCallback((composition) => {
    if (!composition?.id) return 0;
    const length = Math.max(Number(composition.view?.length) || 0, 0);
    const remembered = compositionPlayheadsRef.current.get(composition.id);
    const fallback = clamp(Number(composition.view?.start) || 0, 0, length);
    const value = Number.isFinite(remembered) ? remembered : fallback;
    return clamp(value, 0, length);
  }, []);
  const rememberActiveCompositionPlayhead = useCallback(() => {
    const activeId = activeCompositionIdRef.current;
    if (!activeId) return;
    const length = Math.max(Number(viewRef.current?.length) || 0, 0);
    const value = clamp(Number(playheadRef.current) || 0, 0, length);
    compositionPlayheadsRef.current.set(activeId, value);
  }, []);

  const selectedTrack = useMemo(
    () => project.tracks.find((track) => track.id === selectedTrackId),
    [project.tracks, selectedTrackId]
  );
  const {
    visibleTracks,
    visibleTrackIdsInOrder,
    groupMembersById,
    groupHostByTrackId,
    groupTrackById,
  } = useMemo(() => {
    const members = new Map();
    const hosts = new Map();
    const groups = new Map();
    const rootTracks = [];
    let legacyActiveGroupId = '';

    project.tracks.forEach((track) => {
      if (track.kind !== 'group') return;
      groups.set(track.id, track);
      members.set(track.id, []);
      hosts.set(track.id, null);
    });

    project.tracks.forEach((track) => {
      if (track.kind === 'group') {
        rootTracks.push(track);
        legacyActiveGroupId = track.id;
        return;
      }
      const rawGroupId = typeof track.groupId === 'string' ? track.groupId : '';
      const groupId = rawGroupId && groups.has(rawGroupId)
        ? rawGroupId
        : (track.groupId === null && legacyActiveGroupId ? legacyActiveGroupId : '');
      if (groupId) {
        hosts.set(track.id, groupId);
        members.get(groupId)?.push(track);
      } else {
        hosts.set(track.id, null);
        rootTracks.push(track);
      }
    });

    const visible = [];
    rootTracks.forEach((track) => {
      visible.push(track);
      if (track.kind !== 'group') return;
      if (track.group?.expanded === false) return;
      const childTracks = members.get(track.id) || [];
      visible.push(...childTracks);
    });

    return {
      visibleTracks: visible,
      visibleTrackIdsInOrder: visible.map((track) => track.id),
      groupMembersById: members,
      groupHostByTrackId: hosts,
      groupTrackById: groups,
    };
  }, [project.tracks]);
  const expandTrackIdsWithGroupMembers = useCallback((trackIds) => {
    const source = Array.isArray(trackIds) ? trackIds : [];
    const expanded = [];
    const seen = new Set();

    source.forEach((trackId) => {
      if (!trackId || seen.has(trackId)) return;
      seen.add(trackId);
      expanded.push(trackId);
      const members = groupMembersById.get(trackId);
      if (!Array.isArray(members) || !members.length) return;
      members.forEach((member) => {
        if (!member?.id || seen.has(member.id)) return;
        seen.add(member.id);
        expanded.push(member.id);
      });
    });

    return expanded;
  }, [groupMembersById]);
  const getRenderedTrackHeight = useCallback((track) => {
    if (!track) return project.view.trackHeight;
    if (track.kind === 'group') return project.view.trackHeight;
    const hostId = groupHostByTrackId.get(track.id);
    if (!hostId) return project.view.trackHeight;
    return Math.max(Math.round(project.view.trackHeight * 0.82), 58);
  }, [groupHostByTrackId, project.view.trackHeight]);
  const syncSelectedNodeSnapshot = useCallback((focusTrackId = null) => {
    const snapshot = {};
    selectedNodeIdsByTrackRef.current.forEach((ids, trackId) => {
      if (!Array.isArray(ids) || !ids.length) return;
      snapshot[trackId] = [...ids];
    });
    setSelectedNodeIdsByTrack((prev) => {
      const prevKeys = Object.keys(prev);
      const nextKeys = Object.keys(snapshot);
      if (prevKeys.length === nextKeys.length) {
        const same = nextKeys.every((key) => {
          const a = prev[key] || [];
          const b = snapshot[key] || [];
          return a.length === b.length && a.every((id, index) => id === b[index]);
        });
        if (same) return prev;
      }
      return snapshot;
    });

    const focusId = (
      typeof focusTrackId === 'string'
      && Array.isArray(snapshot[focusTrackId])
      && snapshot[focusTrackId].length
    )
      ? focusTrackId
      : (
        (projectTracksRef.current || [])
          .find((track) => Array.isArray(snapshot[track.id]) && snapshot[track.id].length)?.id
        || null
      );

    if (!focusId) {
      setSelectedNodeContext((prev) => {
        if (prev.trackId === null && prev.nodeIds.length === 0) return prev;
        return { trackId: null, nodeIds: [] };
      });
      return;
    }
    const nodeIds = snapshot[focusId] || [];
    setSelectedNodeContext((prev) => {
      const sameTrack = prev.trackId === focusId;
      const sameLength = prev.nodeIds.length === nodeIds.length;
      const sameNodes = sameLength && prev.nodeIds.every((id, index) => id === nodeIds[index]);
      if (sameTrack && sameNodes) return prev;
      return { trackId: focusId, nodeIds };
    });
  }, []);
  const hasAnyTrackSolo = useMemo(
    () => project.tracks.some((track) => Boolean(track?.solo)),
    [project.tracks]
  );
  const hasAnyTrackMute = useMemo(
    () => project.tracks.some((track) => Boolean(track?.mute)),
    [project.tracks]
  );
  const selectedInspectorNode = useMemo(() => {
    if (!selectedTrack || selectedTrack.kind !== 'osc-flag') return null;
    if (selectedNodeContext.trackId !== selectedTrack.id) return null;
    if (!Array.isArray(selectedNodeContext.nodeIds) || selectedNodeContext.nodeIds.length !== 1) return null;
    const nodeId = selectedNodeContext.nodeIds[0];
    return Array.isArray(selectedTrack.nodes)
      ? (selectedTrack.nodes.find((node) => node.id === nodeId) || null)
      : null;
  }, [selectedTrack, selectedNodeContext]);
  const audioChannelMapTrack = useMemo(
    () => project.tracks.find((track) => track.id === audioChannelMapTrackId && track.kind === 'audio') || null,
    [project.tracks, audioChannelMapTrackId]
  );
  const syncFpsPreset = useMemo(
    () => resolveSyncFps(project.timebase?.syncFps),
    [project.timebase?.syncFps]
  );
  const editingNodeTrack = useMemo(() => {
    if (!editingNode?.trackId) return null;
    return project.tracks.find((track) => track.id === editingNode.trackId) || null;
  }, [editingNode?.trackId, project.tracks]);

  useEffect(() => {
    if (editingNode?.mode !== 'osc-3d') return;
    setOsc3dCamera({ ...OSC3D_CAMERA_DEFAULT });
    osc3dCameraDragRef.current = null;
  }, [editingNode?.mode, editingNode?.trackId, editingNode?.nodeId]);

  const renderOsc3dMonitorWindow = useCallback((trackId) => {
    if (typeof trackId !== 'string' || !trackId) return;
    const monitors = osc3dMonitorWindowsRef.current;
    const entry = monitors.get(trackId);
    if (!entry) return;
    const monitorWindow = entry.window;
    if (!monitorWindow || monitorWindow.closed) {
      if (typeof entry.cleanup === 'function') entry.cleanup();
      monitors.delete(trackId);
      return;
    }

    const tracks = Array.isArray(projectTracksRef.current) ? projectTracksRef.current : [];
    const track = tracks.find((item) => item.id === trackId && item.kind === 'osc-3d') || null;
    if (!track) {
      if (typeof entry.cleanup === 'function') entry.cleanup();
      if (!monitorWindow.closed) monitorWindow.close();
      monitors.delete(trackId);
      return;
    }

    const doc = monitorWindow.document;
    if (!doc) return;
    const nameEl = doc.getElementById('osc3d-track-name');
    const timecodeEl = doc.getElementById('osc3d-timecode');
    const rangeEl = doc.getElementById('osc3d-range');
    const valuesEl = doc.getElementById('osc3d-values');
    const axisEl = doc.getElementById('osc3d-axis');
    const edgesEl = doc.getElementById('osc3d-edges');
    const pointEl = doc.getElementById('osc3d-point');
    if (!nameEl || !timecodeEl || !rangeEl || !valuesEl || !axisEl || !edgesEl || !pointEl) return;

    const projectLength = Number(projectLengthRef.current) || 0;
    const timeSec = clamp(Number(playheadRef.current) || 0, 0, projectLength);
    timecodeEl.textContent = formatHmsfTimecode(timeSec, syncFpsRef.current);

    const bounds = normalizeOsc3dBounds(track);
    const values = sampleOsc3dTrackValues(track, timeSec, projectCurveFpsRef.current);
    const valueType = getOscSendValueType(track);
    const formatAxis = (value) => (
      valueType === 'int'
        ? String(Math.round(Number(value) || 0))
        : Number(value).toFixed(2)
    );

    const trackName = track.name || '3D OSC';
    monitorWindow.document.title = `3D OSC Monitor - ${trackName}`;
    nameEl.textContent = trackName;
    rangeEl.textContent = `X ${bounds.xMin.toFixed(2)}~${bounds.xMax.toFixed(2)} · Y ${bounds.yMin.toFixed(2)}~${bounds.yMax.toFixed(2)} · Z ${bounds.zMin.toFixed(2)}~${bounds.zMax.toFixed(2)}`;
    valuesEl.textContent = `X ${formatAxis(values[0])}  Y ${formatAxis(values[1])}  Z ${formatAxis(values[2])}`;

    const toRatio = (value, min, max) => {
      const span = Math.max(max - min, 1e-9);
      return clamp((value - min) / span, 0, 1);
    };
    const preview = createOsc3dPreviewGeometry({
      x: toRatio(values[0], bounds.xMin, bounds.xMax),
      y: toRatio(values[1], bounds.yMin, bounds.yMax),
      z: toRatio(values[2], bounds.zMin, bounds.zMax),
    }, entry.camera || OSC3D_CAMERA_DEFAULT);

    axisEl.innerHTML = preview.axes.map((axis) => (
      `<g>
        <line x1="${axis.from.x.toFixed(2)}" y1="${axis.from.y.toFixed(2)}" x2="${axis.tip.x.toFixed(2)}" y2="${axis.tip.y.toFixed(2)}" class="axis-line" stroke="${axis.color}" opacity="${clamp(axis.depth, 0.3, 1).toFixed(3)}"></line>
        <text x="${axis.labelPos.x.toFixed(2)}" y="${axis.labelPos.y.toFixed(2)}" class="axis-label" fill="${axis.color}" opacity="${clamp(axis.depth, 0.45, 1).toFixed(3)}">${axis.label}</text>
      </g>`
    )).join('');
    edgesEl.innerHTML = preview.edges.map((edge) => (
      `<line x1="${edge.from.x.toFixed(2)}" y1="${edge.from.y.toFixed(2)}" x2="${edge.to.x.toFixed(2)}" y2="${edge.to.y.toFixed(2)}" stroke="rgba(120,210,255,0.8)" stroke-width="0.8" vector-effect="non-scaling-stroke" opacity="${clamp(edge.depth, 0.25, 1).toFixed(3)}"></line>`
    )).join('');
    pointEl.setAttribute('cx', preview.point.x.toFixed(2));
    pointEl.setAttribute('cy', preview.point.y.toFixed(2));
    pointEl.setAttribute('r', (1.7 + preview.point.depth * 2.2).toFixed(2));
  }, []);

  const refreshOsc3dMonitorWindows = useCallback((trackId = null) => {
    const monitors = osc3dMonitorWindowsRef.current;
    if (!monitors.size) return;
    Array.from(monitors.entries()).forEach(([id, entry]) => {
      if (entry?.window && !entry.window.closed) return;
      if (typeof entry?.cleanup === 'function') entry.cleanup();
      monitors.delete(id);
    });

    if (typeof trackId === 'string' && trackId) {
      renderOsc3dMonitorWindow(trackId);
      return;
    }
    Array.from(monitors.keys()).forEach((id) => renderOsc3dMonitorWindow(id));
  }, [renderOsc3dMonitorWindow]);

  const attachOsc3dMonitorInteraction = useCallback((trackId) => {
    if (typeof trackId !== 'string' || !trackId) return;
    const monitors = osc3dMonitorWindowsRef.current;
    const entry = monitors.get(trackId);
    if (!entry) return;
    const monitorWindow = entry.window;
    if (!monitorWindow || monitorWindow.closed) return;
    if (typeof entry.cleanup === 'function') return;

    const doc = monitorWindow.document;
    const stageHit = doc.getElementById('osc3d-stage-hit');
    if (!stageHit) return;

    const setDragging = (dragging) => {
      stageHit.classList.toggle('dragging', dragging);
    };

    const onPointerMove = (moveEvent) => {
      const drag = entry.drag;
      if (!drag) return;
      const deltaX = moveEvent.clientX - drag.startX;
      const deltaY = moveEvent.clientY - drag.startY;
      entry.camera = {
        yaw: drag.startCamera.yaw + deltaX * 0.35,
        pitch: clamp(drag.startCamera.pitch - deltaY * 0.35, -85, 85),
        zoom: drag.startCamera.zoom,
      };
      refreshOsc3dMonitorWindows(trackId);
    };

    const onPointerUp = () => {
      if (!entry.drag) return;
      entry.drag = null;
      setDragging(false);
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      entry.drag = {
        startX: event.clientX,
        startY: event.clientY,
        startCamera: { ...(entry.camera || OSC3D_CAMERA_DEFAULT) },
      };
      setDragging(true);
    };

    const onWheel = (event) => {
      event.preventDefault();
      const direction = event.deltaY < 0 ? 1 : -1;
      const camera = entry.camera || OSC3D_CAMERA_DEFAULT;
      entry.camera = {
        ...camera,
        zoom: clamp((Number(camera.zoom) || 1) + direction * 0.08, 0.55, 2.4),
      };
      refreshOsc3dMonitorWindows(trackId);
    };

    const onDoubleClick = () => {
      entry.camera = { ...OSC3D_CAMERA_DEFAULT };
      refreshOsc3dMonitorWindows(trackId);
    };

    const cleanup = () => {
      setDragging(false);
      entry.drag = null;
      stageHit.removeEventListener('pointerdown', onPointerDown);
      stageHit.removeEventListener('wheel', onWheel);
      stageHit.removeEventListener('dblclick', onDoubleClick);
      monitorWindow.removeEventListener('pointermove', onPointerMove);
      monitorWindow.removeEventListener('pointerup', onPointerUp);
      monitorWindow.removeEventListener('pointercancel', onPointerUp);
      monitorWindow.removeEventListener('beforeunload', cleanup);
      if (entry.cleanup === cleanup) {
        entry.cleanup = null;
      }
      if (monitors.get(trackId) === entry) {
        monitors.delete(trackId);
      }
    };

    stageHit.addEventListener('pointerdown', onPointerDown);
    stageHit.addEventListener('wheel', onWheel, { passive: false });
    stageHit.addEventListener('dblclick', onDoubleClick);
    monitorWindow.addEventListener('pointermove', onPointerMove);
    monitorWindow.addEventListener('pointerup', onPointerUp);
    monitorWindow.addEventListener('pointercancel', onPointerUp);
    monitorWindow.addEventListener('beforeunload', cleanup);
    entry.cleanup = cleanup;
  }, [refreshOsc3dMonitorWindows]);

  const openOsc3dMonitor = useCallback((trackId = null) => {
    if (typeof window === 'undefined') return;
    const requestedTrackId = typeof trackId === 'string' && trackId
      ? trackId
      : (
        selectedTrack?.kind === 'osc-3d'
          ? selectedTrack.id
          : null
      );
    if (!requestedTrackId) return;

    const tracks = Array.isArray(projectTracksRef.current) ? projectTracksRef.current : [];
    const track = tracks.find((item) => item.id === requestedTrackId && item.kind === 'osc-3d');
    if (!track) return;

    const monitors = osc3dMonitorWindowsRef.current;
    let entry = monitors.get(requestedTrackId);
    let monitorWindow = entry?.window;

    if (!monitorWindow || monitorWindow.closed) {
      monitorWindow = window.open(
        '',
        `${OSC3D_MONITOR_WINDOW_NAME}-${requestedTrackId}`,
        'popup=yes,width=260,height=460,resizable=yes'
      );
      if (!monitorWindow) return;
      monitorWindow.document.open();
      monitorWindow.document.write(OSC3D_MONITOR_HTML);
      monitorWindow.document.close();
      entry = {
        window: monitorWindow,
        camera: { ...OSC3D_CAMERA_DEFAULT },
        drag: null,
        cleanup: null,
      };
      monitors.set(requestedTrackId, entry);
    }

    attachOsc3dMonitorInteraction(requestedTrackId);
    if (typeof monitorWindow.focus === 'function') monitorWindow.focus();
    refreshOsc3dMonitorWindows(requestedTrackId);
  }, [attachOsc3dMonitorInteraction, refreshOsc3dMonitorWindows, selectedTrack?.id, selectedTrack?.kind]);

  useEffect(() => {
    refreshOsc3dMonitorWindows();
  }, [playhead, project.tracks, project.timebase?.fps, syncFpsPreset.fps, refreshOsc3dMonitorWindows]);

  useEffect(() => () => {
    const monitors = osc3dMonitorWindowsRef.current;
    Array.from(monitors.entries()).forEach(([trackId, entry]) => {
      if (typeof entry?.cleanup === 'function') entry.cleanup();
      const monitorWindow = entry?.window;
      if (monitorWindow && !monitorWindow.closed) {
        monitorWindow.close();
      }
      monitors.delete(trackId);
    });
    monitors.clear();
  }, []);

  const midiOutputOptions = useMemo(
    () => [
      { id: VIRTUAL_MIDI_OUTPUT_ID, name: VIRTUAL_MIDI_OUTPUT_NAME },
      ...midiDevices.outputs,
    ],
    [midiDevices.outputs]
  );
  const midiOutputNameMap = useMemo(() => {
    const map = new Map();
    midiOutputOptions.forEach((output) => {
      if (!output?.id) return;
      map.set(output.id, output.name || output.id);
    });
    return map;
  }, [midiOutputOptions]);

  const stopLtcSync = useCallback(() => {
    if (ltcFollowTimeoutRef.current) {
      window.clearTimeout(ltcFollowTimeoutRef.current);
      ltcFollowTimeoutRef.current = null;
    }
    if (ltcProcessorRef.current) {
      try {
        ltcProcessorRef.current.disconnect();
      } catch (error) {
        // Ignore disconnect errors.
      }
      ltcProcessorRef.current.onaudioprocess = null;
      ltcProcessorRef.current = null;
    }
    if (ltcSourceRef.current) {
      try {
        ltcSourceRef.current.disconnect();
      } catch (error) {
        // Ignore disconnect errors.
      }
      ltcSourceRef.current = null;
    }
    if (ltcContextRef.current && typeof ltcContextRef.current.close === 'function') {
      ltcContextRef.current.close().catch(() => {});
      ltcContextRef.current = null;
    }
    if (ltcStreamRef.current) {
      ltcStreamRef.current.getTracks().forEach((streamTrack) => streamTrack.stop());
      ltcStreamRef.current = null;
    }
    ltcDecoderRef.current = null;
  }, []);

  useEffect(() => {
    setSelectedNodeContext((prev) => {
      if (prev.trackId === selectedTrackId) return prev;
      return { trackId: selectedTrackId ?? null, nodeIds: [] };
    });
  }, [selectedTrackId]);

  useEffect(() => {
    const visible = new Set(visibleTrackIdsInOrder);
    if (selectedTrackId && !visible.has(selectedTrackId)) {
      const hostId = groupHostByTrackId.get(selectedTrackId);
      const fallbackId = hostId && visible.has(hostId)
        ? hostId
        : (visibleTrackIdsInOrder[0] ?? null);
      if (fallbackId !== selectedTrackId) {
        dispatch({ type: 'select-track', id: fallbackId });
      }
    }
  }, [dispatch, groupHostByTrackId, selectedTrackId, visibleTrackIdsInOrder]);

  useEffect(() => {
    const visible = new Set(visibleTrackIdsInOrder);
    setSelectedTrackIds((prev) => {
      const filtered = prev.filter((id) => visible.has(id));
      if (!selectedTrackId || !visible.has(selectedTrackId)) return filtered;
      if (!filtered.length) return [selectedTrackId];
      if (!filtered.includes(selectedTrackId)) {
        return [selectedTrackId, ...filtered];
      }
      return filtered;
    });
  }, [selectedTrackId, visibleTrackIdsInOrder]);

  useEffect(() => {
    if (!editingTrackNameId) return;
    const exists = project.tracks.some((track) => track.id === editingTrackNameId);
    if (exists) return;
    setEditingTrackNameId(null);
    setEditingTrackName('');
  }, [editingTrackNameId, project.tracks]);

  useEffect(() => {
    const available = new Set(project.tracks.map((track) => track.id));
    const map = selectedNodeIdsByTrackRef.current;
    let changed = false;
    Array.from(map.keys()).forEach((trackId) => {
      if (!available.has(trackId)) {
        map.delete(trackId);
        changed = true;
      }
    });
    if (changed) {
      syncSelectedNodeSnapshot(selectedTrackId);
    }
  }, [project.tracks, selectedTrackId, syncSelectedNodeSnapshot]);

  useEffect(() => {
    const available = new Set(visibleTrackIdsInOrder);
    if (selectionAnchorTrackIdRef.current && available.has(selectionAnchorTrackIdRef.current)) return;
    selectionAnchorTrackIdRef.current = selectedTrackId && available.has(selectedTrackId)
      ? selectedTrackId
      : (visibleTrackIdsInOrder[0] ?? null);
  }, [selectedTrackId, visibleTrackIdsInOrder]);

  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    syncModeRef.current = project.timebase?.sync || 'Internal';
  }, [project.timebase?.sync]);

  useEffect(() => {
    syncFpsRef.current = Number(syncFpsPreset.fps) || 30;
  }, [syncFpsPreset.fps]);

  useEffect(() => {
    projectCurveFpsRef.current = Number(project.timebase?.fps) || 30;
  }, [project.timebase?.fps]);

  useEffect(() => {
    projectLengthRef.current = Number(project.view.length) || 0;
  }, [project.view.length]);

  useEffect(() => {
    projectTracksRef.current = Array.isArray(project.tracks) ? project.tracks : [];
  }, [project.tracks]);

  useEffect(() => {
    compositionsRef.current = Array.isArray(project.compositions) ? project.compositions : [];
    activeCompositionIdRef.current = project.activeCompositionId || compositionsRef.current[0]?.id || null;
    const alive = new Set();
    compositionsRef.current.forEach((composition) => {
      if (!composition?.id) return;
      alive.add(composition.id);
      const length = Math.max(Number(composition.view?.length) || 0, 0);
      const fallback = clamp(Number(composition.view?.start) || 0, 0, length);
      const remembered = compositionPlayheadsRef.current.get(composition.id);
      if (!Number.isFinite(remembered)) {
        compositionPlayheadsRef.current.set(composition.id, fallback);
        return;
      }
      const clamped = clamp(remembered, 0, length);
      if (clamped !== remembered) {
        compositionPlayheadsRef.current.set(composition.id, clamped);
      }
    });
    Array.from(compositionPlayheadsRef.current.keys()).forEach((compositionId) => {
      if (!alive.has(compositionId)) {
        compositionPlayheadsRef.current.delete(compositionId);
      }
    });
  }, [project.compositions, project.activeCompositionId]);

  useEffect(() => {
    if (!activeCompositionId) return;
    const length = Math.max(Number(project.view.length) || 0, 0);
    const value = clamp(Number(playhead) || 0, 0, length);
    compositionPlayheadsRef.current.set(activeCompositionId, value);
  }, [activeCompositionId, playhead, project.view.length]);

  useEffect(() => {
    cuesRef.current = project.cues || [];
  }, [project.cues]);

  useEffect(() => {
    viewRef.current = project.view;
  }, [project.view]);

  const pushOscRecordingConfig = useCallback((override = {}) => {
    const bridge = window.oscDaw;
    if (!bridge?.setOscRecordingConfig) return;
    const syncMode = syncModeRef.current || 'Internal';
    const useInternalClock = syncMode === 'Internal' && internalClockRef.current.running;
    const payload = {
      armed: isRecording,
      playing: isPlaying,
      fps: Math.max(Number(project.timebase?.fps) || 30, 1),
      projectLength: Math.max(Number(project.view.length) || 0, 0),
      startWallMs: useInternalClock ? internalClockRef.current.startWallMs : Date.now(),
      startPlayhead: useInternalClock
        ? internalClockRef.current.startPlayhead
        : Math.max(Number(playheadRef.current) || 0, 0),
      ...override,
    };
    bridge.setOscRecordingConfig(payload).catch(() => {});
  }, [isRecording, isPlaying, project.timebase?.fps, project.view.length]);

  const startInternalClock = (anchorPlayhead = playheadRef.current) => {
    internalClockRef.current = {
      running: true,
      startPerf: performance.now(),
      startPlayhead: Math.max(Number(anchorPlayhead) || 0, 0),
      startWallMs: Date.now(),
    };
    pushOscRecordingConfig({
      startWallMs: internalClockRef.current.startWallMs,
      startPlayhead: internalClockRef.current.startPlayhead,
    });
  };

  const stopInternalClock = () => {
    internalClockRef.current.running = false;
    pushOscRecordingConfig();
  };

  useEffect(() => {
    pushOscRecordingConfig();
  }, [pushOscRecordingConfig]);

  useEffect(() => {
    if ((project.timebase?.sync || 'Internal') === 'MTC') return;
    mtcStateRef.current = createMtcState();
    mtcPllRef.current = createMtcPllState();
    if (mtcFollowTimeoutRef.current) {
      window.clearTimeout(mtcFollowTimeoutRef.current);
      mtcFollowTimeoutRef.current = null;
    }
  }, [project.timebase?.sync]);

  useEffect(() => {
    const activeTrackIds = new Set(project.tracks.map((track) => track.id));
    audioElementsRef.current.forEach((audio, trackId) => {
      if (activeTrackIds.has(trackId)) return;
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (error) {
        // Ignore cleanup errors.
      }
      audioElementsRef.current.delete(trackId);
      pendingSeekRef.current.delete(trackId);
    });
    audioRoutingRef.current.forEach((_, trackId) => {
      if (activeTrackIds.has(trackId)) return;
      releaseAudioRouting(trackId, true);
    });
    setAudioWaveforms((prev) => {
      let changed = false;
      const next = { ...prev };
      Object.keys(next).forEach((trackId) => {
        if (activeTrackIds.has(trackId)) return;
        delete next[trackId];
        changed = true;
      });
      return changed ? next : prev;
    });
  }, [project.tracks]);

  useEffect(() => {
    if (!audioChannelMapTrackId) return;
    const exists = project.tracks.some((track) => track.id === audioChannelMapTrackId && track.kind === 'audio');
    if (!exists) {
      setAudioChannelMapTrackId(null);
      setAudioChannelMapDraft(null);
    }
  }, [audioChannelMapTrackId, project.tracks]);

  useEffect(() => () => {
    if (mtcFollowTimeoutRef.current) {
      window.clearTimeout(mtcFollowTimeoutRef.current);
      mtcFollowTimeoutRef.current = null;
    }
    mtcPllRef.current = createMtcPllState();
    stopLtcSync();
    audioElementsRef.current.forEach((audio) => {
      try {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      } catch (error) {
        // Ignore media cleanup errors.
      }
    });
    audioElementsRef.current.clear();
    audioRoutingRef.current.forEach((_, trackId) => {
      releaseAudioRouting(trackId, true);
    });
    audioRoutingRef.current.clear();
    audioUrlRef.current.forEach((url) => {
      if (typeof url === 'string' && url.startsWith('blob:')) {
        URL.revokeObjectURL(url);
      }
    });
    audioUrlRef.current.clear();
    pendingSeekRef.current.clear();
    if (audioContextRef.current && typeof audioContextRef.current.close === 'function') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    const bridge = window.oscDaw;
    if (bridge?.pauseNativeAudio) {
      bridge.pauseNativeAudio().catch(() => {});
    }
  }, [stopLtcSync]);

  useEffect(() => {
    if (!isAddTrackMenuOpen) return undefined;
    const close = () => setIsAddTrackMenuOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [isAddTrackMenuOpen]);

  useEffect(() => {
    const element = timelineWidthHostRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    let rafId = 0;
    const markResizing = () => {
      const holdMs = 220;
      resizeHoldUntilRef.current = performance.now() + holdMs;
      setIsUiResizing(true);
      if (resizeIdleTimerRef.current) {
        window.clearTimeout(resizeIdleTimerRef.current);
      }
      resizeIdleTimerRef.current = window.setTimeout(() => {
        resizeIdleTimerRef.current = null;
        setIsUiResizing(false);
      }, holdMs);
    };
    const applyWidth = (nextWidth) => {
      const safe = Math.max(Number(nextWidth) || 0, 320);
      markResizing();
      setTimelineWidth((prev) => (Math.abs(prev - safe) < 0.5 ? prev : safe));
    };
    const observer = new ResizeObserver((entries) => {
      const width = entries?.[0]?.contentRect?.width;
      if (!width) return;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => applyWidth(width));
    });
    observer.observe(element);
    applyWidth(element.getBoundingClientRect().width || TIMELINE_WIDTH);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      if (resizeIdleTimerRef.current) {
        window.clearTimeout(resizeIdleTimerRef.current);
        resizeIdleTimerRef.current = null;
      }
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadOutputs = async () => {
      if (!navigator.mediaDevices?.enumerateDevices) return;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (!mounted) return;
        setAudioOutputs(devices.filter((device) => device.kind === 'audiooutput'));
        setAudioInputs(devices.filter((device) => device.kind === 'audioinput'));
        setAudioOutputError(null);
      } catch (error) {
        if (!mounted) return;
        setAudioOutputError(error?.message || 'Audio output unavailable');
      }
    };
    loadOutputs();
    const handler = () => loadOutputs();
    if (navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', handler);
    }
    return () => {
      mounted = false;
      if (navigator.mediaDevices?.removeEventListener) {
        navigator.mediaDevices.removeEventListener('devicechange', handler);
      }
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.oscDaw;
    if (!bridge || typeof bridge.getAudioOutputChannels !== 'function') return undefined;

    const loadNativeChannelCaps = async () => {
      let result = null;
      try {
        result = await bridge.getAudioOutputChannels();
      } catch (error) {
        result = null;
      }
      if (cancelled || !result || !result.ok) return;
      const byLabelRaw = result.byLabel && typeof result.byLabel === 'object' ? result.byLabel : {};
      const byLabel = new Map();
      Object.entries(byLabelRaw).forEach(([label, channels]) => {
        const key = normalizeAudioDeviceLabel(label);
        const value = clamp(Math.round(Number(channels) || 0), 1, MAX_AUDIO_CHANNELS);
        if (!key || !Number.isFinite(value) || value <= 0) return;
        byLabel.set(key, value);
      });

      const nextCaps = {};
      const defaultChannels = clamp(Math.round(Number(result.defaultOutputChannels) || 2), 1, MAX_AUDIO_CHANNELS);
      nextCaps.default = defaultChannels;
      const defaultOutputLabel = normalizeAudioDeviceLabel(result.defaultOutputLabel || '');

      audioOutputs.forEach((device) => {
        if (!device?.deviceId) return;
        const normalized = normalizeAudioDeviceLabel(device.label || '');
        let channels = byLabel.get(normalized);
        if (!Number.isFinite(channels) && normalized) {
          for (const [labelKey, value] of byLabel.entries()) {
            if (normalized.includes(labelKey) || labelKey.includes(normalized)) {
              channels = value;
              break;
            }
          }
        }
        if (!Number.isFinite(channels) && normalized) {
          const labelHint = parseChannelsFromAudioLabel(device.label || '');
          if (Number.isFinite(labelHint) && labelHint > 0) {
            channels = labelHint;
          }
        }
        if (!Number.isFinite(channels) && normalized && defaultOutputLabel && normalized === defaultOutputLabel) {
          channels = defaultChannels;
        }
        if (!Number.isFinite(channels) || channels <= 0) return;
        nextCaps[device.deviceId] = channels;
      });

      setAudioOutputChannelCaps((prev) => {
        let changed = false;
        const merged = { ...prev };
        Object.entries(nextCaps).forEach(([key, value]) => {
          const previous = Number(merged[key]);
          const next = Number.isFinite(previous) && previous > 0
            ? Math.max(Math.round(previous), value)
            : value;
          if (merged[key] === next) return;
          merged[key] = next;
          changed = true;
        });
        return changed ? merged : prev;
      });
    };

    loadNativeChannelCaps();
    return () => {
      cancelled = true;
    };
  }, [audioOutputs]);

  useEffect(() => {
    let cancelled = false;
    const bridge = window.oscDaw;
    if (!bridge || typeof bridge.getNativeAudioStatus !== 'function') return undefined;
    const loadNativeAudioStatus = async () => {
      let status = null;
      let devices = null;
      try {
        [status, devices] = await Promise.all([
          bridge.getNativeAudioStatus(),
          typeof bridge.getNativeAudioDevices === 'function'
            ? bridge.getNativeAudioDevices()
            : Promise.resolve(null),
        ]);
      } catch (error) {
        status = null;
        devices = null;
      }
      if (cancelled || !status) return;
      setNativeAudioStatus((prev) => ({
        ...prev,
        available: Boolean(status.available),
        streamOpen: Boolean(status.streamOpen),
        streamRunning: Boolean(status.streamRunning),
        api: status.api || null,
        error: status.error || null,
      }));
      if (devices?.ok && Array.isArray(devices.devices)) {
        setNativeAudioDevices(devices.devices);
      }
    };
    loadNativeAudioStatus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    if (!navigator.requestMIDIAccess) {
      setMidiStatus({
        inputName: VIRTUAL_MIDI_INPUT_NAME,
        outputName: VIRTUAL_MIDI_OUTPUT_NAME,
        error: 'Web MIDI not supported',
      });
      return undefined;
    }

    const refreshDevices = () => {
      if (!mounted) return;
      const access = midiAccessRef.current;
      if (!access) return;
      const inputs = Array.from(access.inputs.values()).map((port) => ({
        id: port.id,
        name: port.name || `Input ${port.id.slice(0, 6)}`,
      }));
      const outputs = Array.from(access.outputs.values()).map((port) => ({
        id: port.id,
        name: port.name || `Output ${port.id.slice(0, 6)}`,
      }));
      setMidiDevices({ inputs, outputs });
    };

    const initMidi = async () => {
      try {
        const access = await navigator.requestMIDIAccess({ sysex: true });
        if (!mounted) return;
        midiAccessRef.current = access;
        refreshDevices();
        access.onstatechange = () => {
          refreshDevices();
        };
        return;
      } catch (error) {
        // Fallback without sysex permission.
      }

      try {
        const access = await navigator.requestMIDIAccess({ sysex: false });
        if (!mounted) return;
        midiAccessRef.current = access;
        refreshDevices();
        access.onstatechange = () => {
          refreshDevices();
        };
      } catch (error) {
        if (!mounted) return;
        setMidiStatus((prev) => ({
          ...prev,
          error: error?.message || 'MIDI access failed',
        }));
      }
    };

    initMidi();

    return () => {
      mounted = false;
      const access = midiAccessRef.current;
      if (access) access.onstatechange = null;
      if (midiInputRef.current) {
        try {
          midiInputRef.current.onmidimessage = null;
          if (typeof midiInputRef.current.close === 'function') midiInputRef.current.close();
        } catch (error) {
          // Ignore close errors.
        }
        midiInputRef.current = null;
      }
      if (midiOutputRef.current) {
        try {
          if (typeof midiOutputRef.current.close === 'function') midiOutputRef.current.close();
        } catch (error) {
          // Ignore close errors.
        }
        midiOutputRef.current = null;
      }
      midiAccessRef.current = null;
    };
  }, []);

  useEffect(() => {
    const access = midiAccessRef.current;
    const selectedInputId = project.midi?.inputId || VIRTUAL_MIDI_INPUT_ID;
    const selectedOutputId = project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID;
    const syncMode = project.timebase?.sync || 'Internal';

    if (!access) {
      setMidiStatus((prev) => ({
        ...prev,
        inputName: selectedInputId === VIRTUAL_MIDI_INPUT_ID ? VIRTUAL_MIDI_INPUT_NAME : prev.inputName,
        outputName: selectedOutputId === VIRTUAL_MIDI_OUTPUT_ID ? VIRTUAL_MIDI_OUTPUT_NAME : prev.outputName,
      }));
      return;
    }

    let errorText = null;

    if (midiInputRef.current) {
      try {
        midiInputRef.current.onmidimessage = null;
        if (typeof midiInputRef.current.close === 'function') midiInputRef.current.close();
      } catch (error) {
        // Ignore close errors.
      }
      midiInputRef.current = null;
    }

    if (midiOutputRef.current) {
      try {
        if (typeof midiOutputRef.current.close === 'function') midiOutputRef.current.close();
      } catch (error) {
        // Ignore close errors.
      }
      midiOutputRef.current = null;
    }

    let inputName = VIRTUAL_MIDI_INPUT_NAME;
    let outputName = VIRTUAL_MIDI_OUTPUT_NAME;
    const fallbackInputId = selectedInputId;
    const fallbackOutputId = selectedOutputId;

    if (fallbackInputId !== VIRTUAL_MIDI_INPUT_ID) {
      const input = access.inputs.get(fallbackInputId) || null;
      if (input) {
        inputName = input.name || `Input ${fallbackInputId.slice(0, 6)}`;
        if (typeof input.open === 'function') {
          input.open().catch(() => {});
        }
        const applyMtcTime = (rawTime, mtcFps) => {
          const safeFps = Math.max(Number(mtcFps) || Number(syncFpsPreset.fps) || 30, 1);
          const mtcTime = clamp(Number(rawTime) || 0, 0, project.view.length);
          const now = performance.now();
          const pll = mtcPllRef.current;
          const predicted = predictMtcPllTime(pll, now);
          const error = Number.isFinite(predicted) ? mtcTime - predicted : 0;

          if (!pll.locked || !Number.isFinite(predicted) || Math.abs(error) >= MTC_PLL_REJECT_THRESHOLD_SECONDS) {
            pll.locked = true;
            pll.phase = mtcTime;
            pll.frequency = 1;
            pll.lastUpdateAt = now;
          } else {
            const gainScale = Math.abs(error) > MTC_PLL_ACQUIRE_THRESHOLD_SECONDS ? 2 : 1;
            const nextPhase = predicted + error * MTC_PLL_KP * gainScale;
            const nextFrequency = clamp(
              pll.frequency + error * MTC_PLL_KI * gainScale,
              MTC_PLL_FREQUENCY_MIN,
              MTC_PLL_FREQUENCY_MAX
            );
            pll.phase = clamp(nextPhase, 0, project.view.length);
            pll.frequency = nextFrequency;
            pll.lastUpdateAt = now;
          }

          const smoothedNow = predictMtcPllTime(pll, now);
          if (Number.isFinite(smoothedNow)) {
            setPlayhead(clamp(smoothedNow, 0, project.view.length));
          } else {
            setPlayhead(mtcTime);
          }
          setIsPlaying(true);
          if (mtcFollowTimeoutRef.current) {
            window.clearTimeout(mtcFollowTimeoutRef.current);
          }
          mtcFollowTimeoutRef.current = window.setTimeout(() => {
            mtcStateRef.current = createMtcState();
            mtcPllRef.current = createMtcPllState();
            setIsPlaying(false);
          }, Math.max(450, Math.round(2000 / safeFps)));
        };

        const consumeQuarterFrame = (data1) => {
          const type = (data1 >> 4) & 0x07;
          const value = data1 & 0x0f;
          const mtc = mtcStateRef.current;
          const expectedType = mtc.lastType < 0 ? 0 : ((mtc.lastType + 1) & 0x07);

          if (type !== expectedType) {
            mtc.sequenceValid = type === 0;
            mtc.mask = 0;
          } else if (type === 0 && mtc.lastType === 7) {
            mtc.sequenceValid = true;
            mtc.mask = 0;
          }

          mtc.parts[type] = value;
          mtc.mask |= (1 << type);
          mtc.lastType = type;

          if (!(mtc.sequenceValid && type === 7 && mtc.mask === 0xff)) return;
          mtc.mask = 0;

          const rateType = (mtc.parts[7] >> 1) & 0x03;
          const mtcFps = [24, 25, 29.97, 30][rateType] || Number(syncFpsPreset.fps) || 30;
          const frames = (mtc.parts[1] << 4) | mtc.parts[0];
          const seconds = (mtc.parts[3] << 4) | mtc.parts[2];
          const minutes = (mtc.parts[5] << 4) | mtc.parts[4];
          const hours = ((mtc.parts[7] & 0x1) << 4) | mtc.parts[6];
          const decodedSeconds =
            hours * 3600
            + minutes * 60
            + seconds
            + (frames + MTC_QUARTER_FRAME_COMPENSATION_FRAMES) / Math.max(mtcFps, 1);
          const now = performance.now();
          if (Number.isFinite(mtc.lastDecodedSeconds)) {
            const deltaSeconds = decodedSeconds - mtc.lastDecodedSeconds;
            const deltaMs = now - (mtc.lastDecodedAt || now);
            if (deltaMs < 150 && Math.abs(deltaSeconds) > 1.5) {
              return;
            }
          }
          mtc.lastDecodedSeconds = decodedSeconds;
          mtc.lastDecodedAt = now;
          applyMtcTime(decodedSeconds, mtcFps);
        };

        const consumeFullFrame = (bytes) => {
          if (bytes.length < 10) return;
          if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f || bytes[3] !== 0x01 || bytes[4] !== 0x01) return;
          if (bytes[bytes.length - 1] !== 0xf7) return;
          const hourByte = bytes[5] ?? 0;
          const rateType = (hourByte >> 5) & 0x03;
          const mtcFps = [24, 25, 29.97, 30][rateType] || Number(syncFpsPreset.fps) || 30;
          const hours = hourByte & 0x1f;
          const minutes = (bytes[6] ?? 0) & 0x3f;
          const seconds = (bytes[7] ?? 0) & 0x3f;
          const frames = (bytes[8] ?? 0) & 0x1f;
          applyMtcTime(hours * 3600 + minutes * 60 + seconds + frames / Math.max(mtcFps, 1), mtcFps);
        };

        input.onmidimessage = (event) => {
          const bytes = Array.from(event.data || []);
          if (!bytes.length) return;
          if (syncMode !== 'MTC') return;
          if (bytes[0] >= 0xf8) return;
          if (bytes[0] === 0xf1 && Number.isFinite(bytes[1])) {
            consumeQuarterFrame(bytes[1]);
            return;
          }
          if (bytes[0] === 0xf0) {
            consumeFullFrame(bytes);
          }
        };
        midiInputRef.current = input;
      } else {
        errorText = 'Selected MIDI input is unavailable';
      }
    }

    if (fallbackOutputId !== VIRTUAL_MIDI_OUTPUT_ID) {
      const output = access.outputs.get(fallbackOutputId) || null;
      if (output) {
        outputName = output.name || `Output ${fallbackOutputId.slice(0, 6)}`;
        if (typeof output.open === 'function') {
          output.open().catch(() => {});
        }
        midiOutputRef.current = output;
      } else {
        errorText = errorText || 'Selected MIDI output is unavailable';
      }
    }

    setMidiStatus({
      inputName,
      outputName,
      error: errorText,
    });
  }, [
    project.midi?.inputId,
    project.midi?.outputId,
    project.timebase?.sync,
    project.view.length,
    midiDevices.inputs,
    midiDevices.outputs,
    syncFpsPreset.fps,
  ]);

  useEffect(() => {
    const bridge = window.oscDaw;
    const syncMode = project.timebase?.sync || 'Internal';
    const selectedInputId = project.midi?.inputId || VIRTUAL_MIDI_INPUT_ID;
    if (!bridge?.onVirtualMidiMessage) return undefined;
    if (syncMode !== 'MTC' || selectedInputId !== VIRTUAL_MIDI_INPUT_ID) return undefined;

    const applyMtcTime = (rawTime, mtcFps) => {
      const safeFps = Math.max(Number(mtcFps) || Number(syncFpsPreset.fps) || 30, 1);
      const mtcTime = clamp(Number(rawTime) || 0, 0, project.view.length);
      const now = performance.now();
      const pll = mtcPllRef.current;
      const predicted = predictMtcPllTime(pll, now);
      const error = Number.isFinite(predicted) ? mtcTime - predicted : 0;

      if (!pll.locked || !Number.isFinite(predicted) || Math.abs(error) >= MTC_PLL_REJECT_THRESHOLD_SECONDS) {
        pll.locked = true;
        pll.phase = mtcTime;
        pll.frequency = 1;
        pll.lastUpdateAt = now;
      } else {
        const gainScale = Math.abs(error) > MTC_PLL_ACQUIRE_THRESHOLD_SECONDS ? 2 : 1;
        const nextPhase = predicted + error * MTC_PLL_KP * gainScale;
        const nextFrequency = clamp(
          pll.frequency + error * MTC_PLL_KI * gainScale,
          MTC_PLL_FREQUENCY_MIN,
          MTC_PLL_FREQUENCY_MAX
        );
        pll.phase = clamp(nextPhase, 0, project.view.length);
        pll.frequency = nextFrequency;
        pll.lastUpdateAt = now;
      }

      const smoothedNow = predictMtcPllTime(pll, now);
      if (Number.isFinite(smoothedNow)) {
        setPlayhead(clamp(smoothedNow, 0, project.view.length));
      } else {
        setPlayhead(mtcTime);
      }
      setIsPlaying(true);
      if (mtcFollowTimeoutRef.current) {
        window.clearTimeout(mtcFollowTimeoutRef.current);
      }
      mtcFollowTimeoutRef.current = window.setTimeout(() => {
        mtcStateRef.current = createMtcState();
        mtcPllRef.current = createMtcPllState();
        setIsPlaying(false);
      }, Math.max(450, Math.round(2000 / safeFps)));
    };

    const consumeQuarterFrame = (data1) => {
      const type = (data1 >> 4) & 0x07;
      const value = data1 & 0x0f;
      const mtc = mtcStateRef.current;
      const expectedType = mtc.lastType < 0 ? 0 : ((mtc.lastType + 1) & 0x07);

      if (type !== expectedType) {
        mtc.sequenceValid = type === 0;
        mtc.mask = 0;
      } else if (type === 0 && mtc.lastType === 7) {
        mtc.sequenceValid = true;
        mtc.mask = 0;
      }

      mtc.parts[type] = value;
      mtc.mask |= (1 << type);
      mtc.lastType = type;

      if (!(mtc.sequenceValid && type === 7 && mtc.mask === 0xff)) return;
      mtc.mask = 0;

      const rateType = (mtc.parts[7] >> 1) & 0x03;
      const mtcFps = [24, 25, 29.97, 30][rateType] || Number(syncFpsPreset.fps) || 30;
      const frames = (mtc.parts[1] << 4) | mtc.parts[0];
      const seconds = (mtc.parts[3] << 4) | mtc.parts[2];
      const minutes = (mtc.parts[5] << 4) | mtc.parts[4];
      const hours = ((mtc.parts[7] & 0x1) << 4) | mtc.parts[6];
      const decodedSeconds =
        hours * 3600
        + minutes * 60
        + seconds
        + (frames + MTC_QUARTER_FRAME_COMPENSATION_FRAMES) / Math.max(mtcFps, 1);
      const now = performance.now();
      if (Number.isFinite(mtc.lastDecodedSeconds)) {
        const deltaSeconds = decodedSeconds - mtc.lastDecodedSeconds;
        const deltaMs = now - (mtc.lastDecodedAt || now);
        if (deltaMs < 150 && Math.abs(deltaSeconds) > 1.5) {
          return;
        }
      }
      mtc.lastDecodedSeconds = decodedSeconds;
      mtc.lastDecodedAt = now;
      applyMtcTime(decodedSeconds, mtcFps);
    };

    const consumeFullFrame = (bytes) => {
      if (bytes.length < 10) return;
      if (bytes[0] !== 0xf0 || bytes[1] !== 0x7f || bytes[3] !== 0x01 || bytes[4] !== 0x01) return;
      if (bytes[bytes.length - 1] !== 0xf7) return;
      const hourByte = bytes[5] ?? 0;
      const rateType = (hourByte >> 5) & 0x03;
      const mtcFps = [24, 25, 29.97, 30][rateType] || Number(syncFpsPreset.fps) || 30;
      const hours = hourByte & 0x1f;
      const minutes = (bytes[6] ?? 0) & 0x3f;
      const seconds = (bytes[7] ?? 0) & 0x3f;
      const frames = (bytes[8] ?? 0) & 0x1f;
      applyMtcTime(hours * 3600 + minutes * 60 + seconds + frames / Math.max(mtcFps, 1), mtcFps);
    };

    const unsubscribe = bridge.onVirtualMidiMessage((payload) => {
      const rawBytes = Array.isArray(payload?.bytes) ? payload.bytes : [];
      const bytes = rawBytes
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(0, Math.min(255, Math.round(value))));
      if (!bytes.length) return;
      if (bytes[0] >= 0xf8) return;
      if (bytes[0] === 0xf1 && Number.isFinite(bytes[1])) {
        consumeQuarterFrame(bytes[1]);
        return;
      }
      if (bytes[0] === 0xf0) {
        consumeFullFrame(bytes);
      }
    });

    return () => {
      unsubscribe();
    };
  }, [
    project.midi?.inputId,
    project.timebase?.sync,
    project.view.length,
    syncFpsPreset.fps,
  ]);

  useEffect(() => {
    const bridge = window.oscDaw;
    if (!bridge) return undefined;

    const enqueueOscPayload = (payload) => {
      const address = typeof payload?.address === 'string' ? payload.address : '';
      const value = Number(payload?.value);
      if (!address || !Number.isFinite(value)) return;
      const isRecordSample = payload?.record === true;
      const messageTimestamp = Number(payload?.timestamp);
      const latencySeconds = Number.isFinite(messageTimestamp)
        ? Math.max((Date.now() - messageTimestamp) / 1000, 0)
        : 0;
      let sampleTime = Number(payload?.time);
      if (!Number.isFinite(sampleTime)) {
        sampleTime = playheadRef.current;
        if (isPlayingRef.current && syncModeRef.current === 'Internal' && internalClockRef.current.running) {
          const elapsed = Math.max((performance.now() - internalClockRef.current.startPerf) / 1000, 0);
          sampleTime = internalClockRef.current.startPlayhead + elapsed;
        }
        if (latencySeconds > 0) {
          sampleTime -= latencySeconds;
        }
      }
      const boundedTime = clamp(sampleTime, 0, Math.max(projectLengthRef.current, 0));

      if (isRecordSample) {
        const queue = oscRecordQueueRef.current;
        queue.push({
          address,
          value,
          time: boundedTime,
          record: true,
        });
      } else {
        oscLatestByAddressRef.current.set(address, {
          value,
          time: boundedTime,
          timestamp: Number(payload?.timestamp) || Date.now(),
        });
        oscPendingPreviewRef.current.set(address, {
          address,
          value,
          time: boundedTime,
          record: false,
        });
      }
      const meta = oscMetaRef.current;
      meta.lastAddress = address;
      meta.lastAt = Number(payload?.timestamp) || Date.now();
      meta.dirty = true;
    };

    const unsubscribeStatus =
      typeof bridge.onOscListenStatus === 'function'
        ? bridge.onOscListenStatus((payload) => {
          setOscListenState((prev) => ({
            ...prev,
            status: payload?.status || prev.status,
            port: Number(payload?.port) || prev.port,
            error: payload?.error || null,
          }));
        })
        : () => {};

    let cancelled = false;
    let draining = false;
    const drainOnce = async () => {
      if (cancelled || draining || typeof bridge.drainOscBuffer !== 'function') return;
      draining = true;
      try {
        for (let i = 0; i < 32; i += 1) {
          const result = await bridge.drainOscBuffer({ limit: 8192 });
          if (cancelled) break;
          const dropped = Number(result?.dropped) || 0;
          if (dropped > oscDroppedRef.current) {
            oscDroppedRef.current = dropped;
          }
          const items = Array.isArray(result?.items) ? result.items : [];
          if (items.length) {
            items.forEach((item) => enqueueOscPayload(item));
          }
          if (!items.length || !Number(result?.remaining)) break;
        }
      } catch (error) {
        // Ignore drain errors; next tick will retry.
      } finally {
        draining = false;
      }
    };
    const drainTimer = window.setInterval(drainOnce, 6);
    drainOnce();

    return () => {
      cancelled = true;
      window.clearInterval(drainTimer);
      unsubscribeStatus();
    };
  }, []);

  useEffect(() => {
    const flushOsc = () => {
      const recordQueue = oscRecordQueueRef.current;
      const combined = [];
      if (recordQueue.length) {
        const maxRecordPerFlush = 120000;
        const recordBatch = recordQueue.splice(0, Math.min(recordQueue.length, maxRecordPerFlush));
        combined.push(...recordBatch);
      }
      const pending = oscPendingPreviewRef.current;
      if (pending.size) {
        const batch = Array.from(pending.values());
        pending.clear();
        combined.push(...batch);
      }
      if (combined.length) {
        dispatch({
          type: 'ingest-osc-batch',
          samples: combined,
        });
      }
      const meta = oscMetaRef.current;
      if (meta?.dirty) {
        const now = Date.now();
        if (now - (meta.lastUiSyncAt || 0) < 80) {
          return;
        }
        meta.lastUiSyncAt = now;
        meta.dirty = false;
        setOscListenState((prev) => {
          if (prev.lastAddress === meta.lastAddress && prev.lastAt === meta.lastAt) return prev;
          return {
            ...prev,
            lastAddress: meta.lastAddress,
            lastAt: meta.lastAt,
          };
        });
      }
    };

    const timerId = window.setInterval(flushOsc, 8);
    return () => {
      window.clearInterval(timerId);
    };
  }, []);

  useEffect(() => {
    const bridge = window.oscDaw;
    if (!bridge?.startOscListening || !bridge?.stopOscListening) return undefined;
    const listenPort = Number(project.osc?.listenPort) || 8999;
    let cancelled = false;

    if (!isRecording) {
      const drainBeforeStop = async () => {
        try {
          if (typeof bridge.drainOscBuffer === 'function') {
            for (let i = 0; i < 64; i += 1) {
              const result = await bridge.drainOscBuffer({ limit: 8192 });
              if (cancelled) return;
              const items = Array.isArray(result?.items) ? result.items : [];
              if (items.length) {
                items.forEach((item) => enqueueOscPayload(item));
              }
              if (!items.length || !Number(result?.remaining)) break;
            }
          }
        } catch (error) {
          // Ignore drain failure while stopping.
        }
        if (cancelled) return;
        bridge.stopOscListening().catch(() => {});
        setOscListenState((prev) => {
          if (prev.status === 'stopped' && prev.port === listenPort && !prev.error) return prev;
          return {
            ...prev,
            status: 'stopped',
            port: listenPort,
            error: null,
          };
        });
      };
      drainBeforeStop();
      return () => {
        cancelled = true;
      };
    }

    bridge
      .startOscListening({ port: listenPort })
      .then((result) => {
        if (cancelled) return;
        if (result?.ok) {
          setOscListenState((prev) => ({
            ...prev,
            status: 'listening',
            port: Number(result.port) || listenPort,
            error: null,
          }));
          return;
        }
        setOscListenState((prev) => ({
          ...prev,
          status: 'error',
          port: listenPort,
          error: result?.error || 'Failed to open OSC listening port',
        }));
      })
      .catch((error) => {
        if (cancelled) return;
        setOscListenState((prev) => ({
          ...prev,
          status: 'error',
          port: listenPort,
          error: error?.message || 'Failed to open OSC listening port',
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [project.osc?.listenPort, isRecording]);

  useEffect(() => {
    const bridge = window.oscDaw;
    if (!bridge?.startOscControlListening || !bridge?.onOscControlMessage) return undefined;
    const controlPort = Number(project.osc?.controlPort) || 8998;
    let cancelled = false;

    const unsubscribe = bridge.onOscControlMessage((payload) => {
      if (cancelled) return;
      const address = typeof payload?.address === 'string' ? payload.address.trim().toLowerCase() : '';
      const canonicalAddress = address.startsWith('/osconductor') ? address : '';
      const value = Number(payload?.value);
      const args = Array.isArray(payload?.args) ? payload.args : [];
      if (!canonicalAddress) return;
      const isOn = Number.isFinite(value) ? value >= 0.5 : false;

      const resolveCueNumber = (path, numericValue, argumentList = []) => {
        const argNumber = argumentList
          .map((item) => Number(item))
          .find((item) => Number.isFinite(item));
        if (Number.isFinite(argNumber)) return Math.round(argNumber);
        if (Number.isFinite(numericValue)) return Math.round(numericValue);
        const match = /^\/osconductor\/cue\/(\d+)$/.exec(path);
        if (match) return Number(match[1]);
        return null;
      };

      const resolveOnOffValue = (pathValue, numericValue, argumentList = []) => {
        if (Number.isFinite(pathValue)) return pathValue >= 0.5;
        const argNumber = argumentList
          .map((item) => Number(item))
          .find((item) => Number.isFinite(item));
        if (Number.isFinite(argNumber)) return argNumber >= 0.5;
        if (Number.isFinite(numericValue)) return numericValue >= 0.5;
        return null;
      };

      const jumpToCueNumber = (cueNumber, cueList, view) => {
        if (!Number.isFinite(cueNumber) || cueNumber < 1) return;
        const cues = (Array.isArray(cueList) ? cueList : []).slice().sort((a, b) => a.t - b.t);
        const targetCue = cues[cueNumber - 1];
        if (!targetCue) return;
        const safeView = view || { start: 0, end: 8, length: 600 };
        const cueTime = clamp(Number(targetCue.t) || 0, 0, Math.max(Number(safeView.length) || 0, 0));
        if (isPlayingRef.current && (syncModeRef.current || 'Internal') === 'Internal') {
          startInternalClock(cueTime);
        }
        lastTickRef.current = null;
        setPlayhead(cueTime);

        const viewStart = Number(safeView.start) || 0;
        const viewEnd = Number(safeView.end) || 0;
        const span = Math.max(viewEnd - viewStart, 1);
        if (cueTime < viewStart || cueTime > viewEnd) {
          const nextStart = clamp(
            cueTime - span * 0.25,
            0,
            Math.max((Number(safeView.length) || 0) - span, 0)
          );
          dispatch({ type: 'scroll-time', start: nextStart });
        }
      };

      const switchCompositionByNumber = (compositionNumber) => {
        const list = compositionsRef.current || [];
        if (!Number.isFinite(compositionNumber) || compositionNumber < 1) return null;
        const target = list[Math.round(compositionNumber) - 1];
        if (!target) return null;
        if (target.id !== activeCompositionIdRef.current) {
          rememberActiveCompositionPlayhead();
          setIsPlaying(false);
          stopInternalClock();
          lastTickRef.current = null;
          dispatch({ type: 'switch-composition', id: target.id });
          const startTime = getRememberedCompositionPlayhead(target);
          setPlayhead(startTime);
          syncAudioToPlayhead(startTime);
          setSelectedNodeContext({ trackId: null, nodeIds: [] });
        }
        return target;
      };

      const compositionMatch = /^\/osconductor\/composition\/(\d+)\/([a-z0-9_-]+)(?:\/(\d+))?$/.exec(canonicalAddress);
      if (compositionMatch) {
        const compositionNumber = Number(compositionMatch[1]);
        const command = compositionMatch[2];
        const commandPathValue = compositionMatch[3] ? Number(compositionMatch[3]) : null;
        const targetComposition = switchCompositionByNumber(compositionNumber);
        if (!targetComposition) return;

        if (command === 'select') {
          return;
        }
        if (command === 'rec') {
          if (!Number.isFinite(value)) return;
          setIsRecording((prev) => (prev === isOn ? prev : isOn));
          return;
        }
        if (command === 'play') {
          if (!Number.isFinite(value)) return;
          setIsPlaying((prev) => (prev === isOn ? prev : isOn));
          return;
        }
        if (command === 'stop') {
          if (!Number.isFinite(value) || !isOn) return;
          setIsPlaying(false);
          stopInternalClock();
          lastTickRef.current = null;
          dispatch({ type: 'scroll-time', start: 0 });
          setPlayhead(0);
          syncAudioToPlayhead(0);
          return;
        }
        if (command === 'cue') {
          const cueNumber = resolveCueNumber(
            canonicalAddress,
            Number.isFinite(commandPathValue) ? commandPathValue : value,
            args
          );
          jumpToCueNumber(cueNumber, targetComposition.cues, targetComposition.view);
          return;
        }
        if (command === 'loop') {
          const nextLoopEnabled = resolveOnOffValue(commandPathValue, value, args);
          if (nextLoopEnabled === null) return;
          dispatch({
            type: 'update-project',
            patch: { view: { loopEnabled: nextLoopEnabled } },
          });
        }
        return;
      }

      if (canonicalAddress === '/osconductor/rec') {
        if (!Number.isFinite(value)) return;
        setIsRecording((prev) => (prev === isOn ? prev : isOn));
        return;
      }
      if (canonicalAddress === '/osconductor/play') {
        if (!Number.isFinite(value)) return;
        setIsPlaying((prev) => (prev === isOn ? prev : isOn));
        return;
      }
      if (canonicalAddress === '/osconductor/stop') {
        if (!Number.isFinite(value) || !isOn) return;
        setIsPlaying(false);
        stopInternalClock();
        lastTickRef.current = null;
        dispatch({ type: 'scroll-time', start: 0 });
        setPlayhead(0);
        syncAudioToPlayhead(0);
        return;
      }
      if (canonicalAddress === '/osconductor/cue' || canonicalAddress.startsWith('/osconductor/cue/')) {
        const cueNumber = resolveCueNumber(canonicalAddress, value, args);
        jumpToCueNumber(cueNumber, cuesRef.current, viewRef.current);
        return;
      }
      if (canonicalAddress === '/osconductor/loop' || canonicalAddress.startsWith('/osconductor/loop/')) {
        const nextLoopEnabled = resolveOnOffValue(null, value, args);
        if (nextLoopEnabled === null) return;
        dispatch({
          type: 'update-project',
          patch: { view: { loopEnabled: nextLoopEnabled } },
        });
      }
    });

    bridge.startOscControlListening({ port: controlPort }).catch(() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [project.osc?.controlPort, getRememberedCompositionPlayhead, rememberActiveCompositionPlayhead]);

  useEffect(() => () => {
    const bridge = window.oscDaw;
    if (!bridge?.stopOscListening) return;
    bridge.stopOscListening().catch(() => {});
  }, []);

  useEffect(() => () => {
    const bridge = window.oscDaw;
    if (!bridge?.stopOscControlListening) return;
    bridge.stopOscControlListening().catch(() => {});
  }, []);

  const sampleTrackValue = (track, time) => {
    const nodes = track.nodes || [];
    if (nodes.length === 0) return clamp(track.default, track.min, track.max);
    if (time <= nodes[0].t) return clamp(nodes[0].v, track.min, track.max);
    if (time >= nodes[nodes.length - 1].t) return clamp(nodes[nodes.length - 1].v, track.min, track.max);
    for (let i = 0; i < nodes.length - 1; i += 1) {
      const a = nodes[i];
      const b = nodes[i + 1];
      if (time >= a.t && time <= b.t) {
        if (a.t === b.t) return clamp(b.v, track.min, track.max);
        const ratio = getCurveValueRatioByFps(
          (time - a.t) / (b.t - a.t),
          a.curve,
          project.timebase?.fps
        );
        const value = a.v + ratio * (b.v - a.v);
        return clamp(value, track.min, track.max);
      }
    }
    return clamp(nodes[nodes.length - 1].v, track.min, track.max);
  };

  const isTrackEnabled = (track, kind) => {
    if (!track || track.kind !== kind) return false;
    // Mute must always win.
    if (track.mute) return false;
    // Solo works globally across all tracks.
    const hasSolo = project.tracks.some((item) => Boolean(item?.solo) && !Boolean(item?.mute));
    if (!hasSolo) return true;
    return Boolean(track.solo);
  };

  const getAudioClipStart = (track) => (
    Math.max(Number(track?.audio?.clipStart) || 0, 0)
  );

  const getTrackMeterLevel = (track) => {
    if (!track) return 0;
    const kind = track.kind;
    if (!isTrackEnabled(track, kind)) return 0;

    if (kind === 'audio') {
      if (!isPlaying) return 0;
      const waveform = audioWaveforms[track.id];
      const peaks = Array.isArray(waveform?.peaks)
        ? waveform.peaks
        : (Array.isArray(track.audio?.waveformPeaks) ? track.audio.waveformPeaks : []);
      const duration = Number.isFinite(waveform?.duration) && waveform.duration > 0
        ? waveform.duration
        : (Number.isFinite(track.audio?.waveformDuration) && track.audio.waveformDuration > 0
          ? track.audio.waveformDuration
          : (Number.isFinite(track.audio?.duration) && track.audio.duration > 0 ? track.audio.duration : 0));
      const volume = clamp(Number(track.audio?.volume ?? 1), 0, 1);
      const clipStart = getAudioClipStart(track);
      const localTime = playhead - clipStart;
      if (localTime < 0 || (duration > 0 && localTime > duration)) return 0;
      if (peaks.length > 1 && duration > 0) {
        const safeTime = clamp(localTime, 0, duration);
        const progress = safeTime / Math.max(duration, 0.000001);
        const peakIndex = clamp(Math.round(progress * (peaks.length - 1)), 0, peaks.length - 1);
        const peak = clamp(Number(peaks[peakIndex]) || 0, 0, 1);
        return clamp(Math.sqrt(peak) * volume, 0, 1);
      }
      return clamp(volume * 0.2, 0, 1);
    }

    const min = Number.isFinite(track.min) ? track.min : 0;
    const max = Number.isFinite(track.max) ? track.max : 1;
    const span = Math.max(max - min, 0.000001);
    const value = sampleTrackValue(track, playhead);
    return clamp((value - min) / span, 0, 1);
  };

  const getMeterLevelClass = (level) => {
    if (level >= 0.9) return 'is-red';
    if (level >= 0.72) return 'is-yellow';
    return 'is-green';
  };

  const getMidiTrackOutputId = (track) => {
    if (typeof track?.midi?.outputId === 'string' && track.midi.outputId) return track.midi.outputId;
    return project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID;
  };

  const getAudioSourceChannels = (track) => (
    clamp(Math.round(Number(track?.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS)
  );

  const getAudioChannelMap = (track, channels = getAudioSourceChannels(track)) => {
    const safeChannels = clamp(Math.round(Number(channels) || 2), 1, MAX_AUDIO_CHANNELS);
    const raw = Array.isArray(track?.audio?.channelMap) ? track.audio.channelMap : [];
    return Array.from({ length: safeChannels }, (_, index) => {
      const fallback = index + 1;
      const value = Math.round(Number(raw[index]) || fallback);
      return clamp(value, 1, MAX_AUDIO_CHANNELS);
    });
  };

  const releaseAudioRouting = (trackId, removeEntry = true) => {
    const routing = audioRoutingRef.current.get(trackId);
    if (!routing) return;
    safeDisconnectAudioNode(routing.splitterNode);
    safeDisconnectAudioNode(routing.mergerNode);
    safeDisconnectAudioNode(routing.gainNode);
    safeDisconnectAudioNode(routing.sourceNode);
    routing.splitterNode = null;
    routing.mergerNode = null;
    routing.gainNode = null;
    routing.sourceNode = null;
    routing.mapKey = '';
    if (routing.context && typeof routing.context.close === 'function') {
      routing.context.close().catch(() => {});
    }
    routing.context = null;
    routing.sinkId = null;
    if (removeEntry) {
      audioRoutingRef.current.delete(trackId);
    }
  };

  const clearAudioRoutingGraph = (trackId) => {
    const routing = audioRoutingRef.current.get(trackId);
    if (!routing) return;
    safeDisconnectAudioNode(routing.sourceNode);
    safeDisconnectAudioNode(routing.splitterNode);
    safeDisconnectAudioNode(routing.mergerNode);
    safeDisconnectAudioNode(routing.gainNode);
    routing.splitterNode = null;
    routing.mergerNode = null;
    routing.gainNode = null;
    routing.mapKey = '';
  };

  const resolveTrackOutputDeviceId = (track) => {
    const trackDeviceId =
      typeof track?.audio?.outputDeviceId === 'string' && track.audio.outputDeviceId
        ? track.audio.outputDeviceId
        : 'project-default';
    if (trackDeviceId === 'project-default') {
      const projectOutput = project.audio?.outputDeviceId || 'default';
      if (typeof projectOutput === 'string' && projectOutput.startsWith('native:')) {
        return 'default';
      }
      return projectOutput;
    }
    if (trackDeviceId.startsWith('native:')) return 'default';
    return trackDeviceId;
  };

  const normalizeAudioDeviceLabel = (value) => (
    typeof value === 'string'
      ? value.trim().toLowerCase().replace(/\s+/g, ' ')
      : ''
  );

  const parseChannelsFromAudioLabel = (label) => {
    if (typeof label !== 'string') return null;
    const normalized = label.trim().toLowerCase();
    if (!normalized) return null;
    const match = /(\d+)\s*ch(?:annels?)?\b/i.exec(normalized);
    if (!match) return null;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    return clamp(Math.round(value), 1, MAX_AUDIO_CHANNELS);
  };

  const getDetectedOutputChannels = (deviceId) => {
    const key = typeof deviceId === 'string' && deviceId ? deviceId : 'default';
    if (key.startsWith('native:')) {
      const nativeDeviceId = Number(key.slice('native:'.length));
      const nativeChannels = nativeAudioDevices.find((device) => device.id === nativeDeviceId)?.outputChannels;
      if (Number.isFinite(nativeChannels) && nativeChannels > 0) {
        return clamp(Math.round(nativeChannels), 1, MAX_AUDIO_CHANNELS);
      }
    }
    const value = Number(audioOutputChannelCaps[key]);
    const labelHint = parseChannelsFromAudioLabel(
      audioOutputs.find((device) => device.deviceId === key)?.label || ''
    );
    if (Number.isFinite(labelHint) && labelHint > 0) {
      if (!Number.isFinite(value) || value <= 0) {
        return labelHint;
      }
      return clamp(Math.max(Math.round(value), labelHint), 1, MAX_AUDIO_CHANNELS);
    }
    if (Number.isFinite(value) && value > 0) {
      return clamp(Math.round(value), 1, MAX_AUDIO_CHANNELS);
    }
    return 2;
  };

  const probeOutputChannels = useCallback(async (deviceId) => {
    const key = typeof deviceId === 'string' && deviceId ? deviceId : 'default';
    if (key.startsWith('native:')) {
      const nativeDeviceId = Number(key.slice('native:'.length));
      const nativeChannels = nativeAudioDevices.find((device) => device.id === nativeDeviceId)?.outputChannels;
      if (Number.isFinite(nativeChannels) && nativeChannels > 0) {
        return clamp(Math.round(nativeChannels), 1, MAX_AUDIO_CHANNELS);
      }
      return 2;
    }
    if (nativeAudioStatus.available && key !== 'default') {
      const fallback = Number(audioOutputChannelCaps[key]);
      if (Number.isFinite(fallback) && fallback > 0) {
        return clamp(Math.round(fallback), 1, MAX_AUDIO_CHANNELS);
      }
      return 2;
    }
    const cached = Number(audioOutputChannelCaps[key]);
    if (Number.isFinite(cached) && cached > 0) {
      return clamp(Math.round(cached), 1, MAX_AUDIO_CHANNELS);
    }
    const runningProbe = audioOutputProbeRef.current.get(key);
    if (runningProbe) {
      return runningProbe;
    }
    const probeTask = (async () => {
      const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextImpl) return 2;
      let context = null;
      try {
        context = new AudioContextImpl({ latencyHint: 'interactive' });
        if (typeof context.setSinkId === 'function') {
          await context.setSinkId(key);
        }
        const detected = Math.max(
          Number(context.destination?.maxChannelCount) || 0,
          Number(context.destination?.channelCount) || 0,
          2
        );
        const channels = clamp(Math.round(detected), 1, MAX_AUDIO_CHANNELS);
        setAudioOutputChannelCaps((prev) => {
          const previous = Number(prev[key]);
          const next = Number.isFinite(previous) && previous > 0
            ? Math.max(Math.round(previous), channels)
            : channels;
          return prev[key] === next ? prev : { ...prev, [key]: next };
        });
        return channels;
      } catch (error) {
        setAudioOutputChannelCaps((prev) => (Number.isFinite(prev[key]) ? prev : { ...prev, [key]: 2 }));
        return 2;
      } finally {
        if (context && typeof context.close === 'function') {
          context.close().catch(() => {});
        }
      }
    })();
    audioOutputProbeRef.current.set(key, probeTask);
    try {
      return await probeTask;
    } finally {
      audioOutputProbeRef.current.delete(key);
    }
  }, [audioOutputChannelCaps, nativeAudioDevices, nativeAudioStatus.available]);

  useEffect(() => {
    const resolveOutputId = (track) => {
      const trackDeviceId =
        typeof track?.audio?.outputDeviceId === 'string' && track.audio.outputDeviceId
          ? track.audio.outputDeviceId
          : 'project-default';
      if (trackDeviceId === 'project-default') {
        return project.audio?.outputDeviceId || 'default';
      }
      return trackDeviceId;
    };

    const targets = new Set(['default']);
    audioOutputs.forEach((device) => {
      if (typeof device.deviceId === 'string' && device.deviceId) {
        targets.add(device.deviceId);
      }
    });
    project.tracks.forEach((track) => {
      if (track.kind !== 'audio') return;
      if (!track.audio?.channelMapEnabled) return;
      targets.add(resolveOutputId(track));
    });
    if (audioChannelMapTrack) {
      targets.add(resolveOutputId(audioChannelMapTrack));
    }
    targets.forEach((deviceId) => {
      probeOutputChannels(deviceId);
    });
  }, [audioOutputs, project.tracks, audioChannelMapTrack, project.audio?.outputDeviceId, probeOutputChannels]);

  const applyRoutingSinkId = (routing, deviceId) => {
    const context = routing?.context;
    if (!context || typeof context.setSinkId !== 'function') return;
    if (routing.sinkId === deviceId) return;
    context.setSinkId(deviceId)
      .then(() => {
        routing.sinkId = deviceId;
        routing.mapKey = '';
      })
      .catch(() => {
        routing.sinkId = null;
        routing.mapKey = '';
        // Ignore sink routing errors when unsupported by browser/runtime.
      });
  };

  const ensureMappedAudioRouting = (track, audio) => {
    if (!track || track.kind !== 'audio' || !audio) return null;
    if (!track.audio?.channelMapEnabled) {
      clearAudioRoutingGraph(track.id);
      return null;
    }
    const targetDeviceId = resolveTrackOutputDeviceId(track);
    const outputLimit = getDetectedOutputChannels(targetDeviceId);
    // Chromium mixer frequently fails for non-default sink or >32ch output.
    // Keep playback alive by falling back to HTMLMediaElement routing in those cases.
    if (targetDeviceId !== 'default' || outputLimit > MAX_WEB_AUDIO_OUTPUT_CHANNELS) {
      clearAudioRoutingGraph(track.id);
      return null;
    }
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextImpl) {
      clearAudioRoutingGraph(track.id);
      return null;
    }

    let routing = audioRoutingRef.current.get(track.id);
    if (!routing || routing.audio !== audio) {
      if (routing) {
        releaseAudioRouting(track.id, true);
      }
      routing = {
        context: null,
        audio,
        sourceNode: null,
        splitterNode: null,
        mergerNode: null,
        gainNode: null,
        mapKey: '',
        sinkId: null,
      };
      audioRoutingRef.current.set(track.id, routing);
    }

    if (!routing.context) {
      try {
        routing.context = new AudioContextImpl({
          latencyHint: 'interactive',
          sinkId: targetDeviceId,
        });
      } catch (error) {
        routing.context = new AudioContextImpl({ latencyHint: 'interactive' });
      }
      routing.sinkId = null;
    }
    const context = routing.context;
    if (context.state === 'suspended' && typeof context.resume === 'function') {
      context.resume().catch(() => {});
    }
    applyRoutingSinkId(routing, targetDeviceId);
    if (!Number.isFinite(audioOutputChannelCaps[targetDeviceId])) {
      probeOutputChannels(targetDeviceId);
    }

    if (!routing.sourceNode) {
      try {
        routing.sourceNode = context.createMediaElementSource(audio);
      } catch (error) {
        clearAudioRoutingGraph(track.id);
        return null;
      }
    }

    const sourceChannels = getAudioSourceChannels(track);
    const destinationLimit = Number(context.destination?.maxChannelCount);
    const safeDestinationLimit = Number.isFinite(destinationLimit) && destinationLimit > 0
      ? clamp(Math.round(destinationLimit), 1, MAX_WEB_AUDIO_OUTPUT_CHANNELS)
      : MAX_WEB_AUDIO_OUTPUT_CHANNELS;
    const routeOutputLimit = clamp(
      Math.min(outputLimit, safeDestinationLimit),
      1,
      MAX_WEB_AUDIO_OUTPUT_CHANNELS
    );
    const channelMap = getAudioChannelMap(track, sourceChannels)
      .map((output) => clamp(output, 1, routeOutputLimit));
    const outputChannels = Math.max(
      channelMap.reduce((max, value) => Math.max(max, value), 0),
      2
    );
    const mapKey = `${targetDeviceId}|${sourceChannels}|${routeOutputLimit}|${outputChannels}|${channelMap.join(',')}`;
    if (routing.mapKey !== mapKey || !routing.splitterNode || !routing.mergerNode || !routing.gainNode) {
      clearAudioRoutingGraph(track.id);
      try {
        routing.splitterNode = context.createChannelSplitter(sourceChannels);
        routing.mergerNode = context.createChannelMerger(outputChannels);
        routing.gainNode = context.createGain();
        try {
          routing.splitterNode.channelInterpretation = 'discrete';
        } catch (error) {
          // Ignore unsupported channel interpretation settings.
        }
        try {
          routing.mergerNode.channelInterpretation = 'discrete';
        } catch (error) {
          // Ignore unsupported channel interpretation settings.
        }
        routing.sourceNode.connect(routing.splitterNode);
        channelMap.forEach((outChannel, inputIndex) => {
          if (!Number.isFinite(outChannel) || outChannel <= 0 || outChannel > outputChannels) return;
          routing.splitterNode.connect(routing.mergerNode, inputIndex, outChannel - 1);
        });
        routing.mergerNode.connect(routing.gainNode);
        routing.gainNode.connect(context.destination);
        routing.mapKey = mapKey;
      } catch (error) {
        clearAudioRoutingGraph(track.id);
        return null;
      }
    }

    return routing;
  };

  const getWaveformSampleCount = (durationHint = project.view.length) => {
    const sampleRate = clamp(Number(project.audio?.sampleRate) || 48000, 8000, 192000);
    const bufferSize = Number(project.audio?.bufferSize) || 1024;
    const safeBufferSize = AUDIO_BUFFER_SIZES.includes(bufferSize) ? bufferSize : 1024;
    const duration = Math.max(Number(durationHint) || 0, 1);
    const estimate = Math.round((duration * sampleRate) / safeBufferSize);
    return clamp(estimate, 600, 3600);
  };

  const computePeaks = (audioBuffer, samples = 320) => {
    const channels = Math.max(audioBuffer.numberOfChannels || 1, 1);
    const length = audioBuffer.length || 0;
    if (length === 0) return [];
    const leftChannel = audioBuffer.getChannelData(0);
    const blockSize = Math.max(Math.floor(length / samples), 1);
    const peaks = new Array(samples).fill(0);
    for (let i = 0; i < samples; i += 1) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, length);
      let max = 0;
      for (let j = start; j < end; j += 1) {
        const value = Math.abs(leftChannel[j] || 0);
        if (value > max) max = value;
      }
      if (channels > 1 && max === 0) max = 0;
      peaks[i] = max;
    }
    return peaks;
  };

  const createSilentPeaks = (samples = 1200) => {
    const count = Math.max(Number(samples) || 0, 24);
    return Array.from({ length: count }, (_, index) => {
      const phase = (index / Math.max(count - 1, 1)) * Math.PI * 10;
      return 0.05 + Math.abs(Math.sin(phase)) * 0.06;
    });
  };

  const readFourCC = (view, offset) => String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3)
  );

  const parseWavHeader = (arrayBuffer) => {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 44) return null;
    if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') return null;

    let offset = 12;
    let format = null;
    let channels = 1;
    let sampleRate = 0;
    let bitsPerSample = 16;
    let blockAlign = 0;
    let dataOffset = 0;
    let dataSize = 0;

    while (offset + 8 <= view.byteLength) {
      const chunkId = readFourCC(view, offset);
      const chunkSize = view.getUint32(offset + 4, true);
      const chunkDataOffset = offset + 8;
      const chunkEnd = chunkDataOffset + chunkSize;
      if (chunkEnd > view.byteLength) break;

      if (chunkId === 'fmt ' && chunkSize >= 16) {
        format = view.getUint16(chunkDataOffset, true);
        channels = Math.max(view.getUint16(chunkDataOffset + 2, true), 1);
        sampleRate = view.getUint32(chunkDataOffset + 4, true);
        blockAlign = view.getUint16(chunkDataOffset + 12, true);
        bitsPerSample = view.getUint16(chunkDataOffset + 14, true);
      } else if (chunkId === 'data') {
        dataOffset = chunkDataOffset;
        dataSize = chunkSize;
        break;
      }

      offset = chunkEnd + (chunkSize % 2);
    }

    if (!format || !sampleRate || !blockAlign || !dataSize) return null;
    return {
      format,
      channels,
      sampleRate,
      bitsPerSample,
      blockAlign,
      dataOffset,
      dataSize,
    };
  };

  const readWavSample = (view, offset, format, bitsPerSample) => {
    if (format === 1) {
      if (bitsPerSample === 8) {
        if (offset + 1 > view.byteLength) return null;
        return (view.getUint8(offset) - 128) / 128;
      }
      if (bitsPerSample === 16) {
        if (offset + 2 > view.byteLength) return null;
        return view.getInt16(offset, true) / 32768;
      }
      if (bitsPerSample === 24) {
        if (offset + 3 > view.byteLength) return null;
        const b0 = view.getUint8(offset);
        const b1 = view.getUint8(offset + 1);
        const b2 = view.getUint8(offset + 2);
        let value = b0 | (b1 << 8) | (b2 << 16);
        if (value & 0x800000) value |= 0xff000000;
        return value / 8388608;
      }
      if (bitsPerSample === 32) {
        if (offset + 4 > view.byteLength) return null;
        return view.getInt32(offset, true) / 2147483648;
      }
    }
    if (format === 3) {
      if (bitsPerSample === 32) {
        if (offset + 4 > view.byteLength) return null;
        return view.getFloat32(offset, true);
      }
      if (bitsPerSample === 64) {
        if (offset + 8 > view.byteLength) return null;
        return view.getFloat64(offset, true);
      }
    }
    return null;
  };

  const computeWavLeftPeaks = (arrayBuffer, samples = 1200) => {
    const header = parseWavHeader(arrayBuffer);
    if (!header) return null;
    const view = new DataView(arrayBuffer);
    const frameCount = Math.floor(header.dataSize / header.blockAlign);
    if (frameCount <= 0) return null;
    const duration = frameCount / header.sampleRate;
    const count = Math.max(Number(samples) || 0, 24);
    const step = Math.max(Math.floor(frameCount / count), 1);
    const peaks = new Array(count).fill(0);

    for (let i = 0; i < count; i += 1) {
      const startFrame = i * step;
      const endFrame = Math.min(startFrame + step, frameCount);
      let peak = 0;
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        const sampleOffset = header.dataOffset + frame * header.blockAlign;
        const sample = readWavSample(view, sampleOffset, header.format, header.bitsPerSample);
        if (sample === null) return null;
        const abs = Math.abs(sample);
        if (abs > peak) peak = abs;
      }
      peaks[i] = Math.min(Math.max(peak, 0), 1);
    }

    return {
      peaks,
      duration,
      channels: header.channels,
    };
  };

  const decodeAudioBuffer = async (context, arrayBuffer) => new Promise((resolve, reject) => {
    const source = arrayBuffer.slice(0);
    let settled = false;
    const onResolve = (buffer) => {
      if (settled) return;
      settled = true;
      resolve(buffer);
    };
    const onReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const maybePromise = context.decodeAudioData(source, onResolve, onReject);
    if (maybePromise && typeof maybePromise.then === 'function') {
      maybePromise.then(onResolve).catch(onReject);
    }
  });

  const getTrackAudioDuration = (track, audio) => {
    if (audio && Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    if (Number.isFinite(track?.audio?.duration) && track.audio.duration > 0) return track.audio.duration;
    return Math.max(project.view.length || 0, 0.1);
  };

  const getAudioTrackTiming = (track, audio, timelineTime) => {
    const duration = getTrackAudioDuration(track, audio);
    const clipStart = getAudioClipStart(track);
    const localTime = Number(timelineTime) - clipStart;
    return {
      duration,
      clipStart,
      localTime,
      inRange: localTime >= 0 && localTime < duration,
    };
  };

  const seekAudioElement = (track, audio, time) => {
    if (!track || !audio) return;
    const duration = getTrackAudioDuration(track, audio);
    const safeTime = clamp(Math.max(time, 0), 0, Math.max(duration - 0.001, 0));
    const canSeek = audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0;
    if (!canSeek) {
      pendingSeekRef.current.set(track.id, safeTime);
      return;
    }
    try {
      if (!Number.isFinite(audio.currentTime) || Math.abs(audio.currentTime - safeTime) > 0.01) {
        audio.currentTime = safeTime;
      }
      pendingSeekRef.current.delete(track.id);
    } catch (error) {
      pendingSeekRef.current.set(track.id, safeTime);
    }
  };

  const getAudioElement = (track) => {
    if (track.kind !== 'audio' || !track.audio?.src) return null;
    const existing = audioElementsRef.current.get(track.id);
    if (existing) {
      if (existing.src !== track.audio.src) {
        existing.pause();
        existing.src = track.audio.src;
        existing.load();
        const pending = pendingSeekRef.current.get(track.id);
        if (Number.isFinite(pending)) seekAudioElement(track, existing, pending);
      }
      return existing;
    }
    const audio = new Audio(track.audio.src);
    audio.preload = 'auto';
    audio.addEventListener('loadedmetadata', () => {
      const pending = pendingSeekRef.current.get(track.id);
      if (Number.isFinite(pending)) seekAudioElement(track, audio, pending);
    });
    audioElementsRef.current.set(track.id, audio);
    return audio;
  };

  const audioOutputLabelById = useMemo(() => {
    const map = new Map();
    audioOutputs.forEach((device) => {
      if (!device?.deviceId) return;
      map.set(device.deviceId, device.label || '');
    });
    return map;
  }, [audioOutputs]);
  const nativeAudioTrackDescriptors = useMemo(() => (
    project.tracks
      .filter((track) => track.kind === 'audio' && track.audio?.src)
      .map((track) => {
        const filePath =
          typeof track.audio?.nativePath === 'string' && track.audio.nativePath.trim()
            ? track.audio.nativePath.trim()
            : '';
        const sourceChannels = clamp(Math.round(Number(track.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS);
        const channelMapEnabled = Boolean(track.audio?.channelMapEnabled);
        const mapped = Array.isArray(track.audio?.channelMap) ? track.audio.channelMap : [];
        const channelMap = channelMapEnabled
          ? mapped
          : Array.from({ length: sourceChannels }, (_, index) => index + 1);
        return {
          id: track.id,
          filePath,
          clipStart: getAudioClipStart(track),
          volume: clamp(Number.isFinite(track.audio?.volume) ? track.audio.volume : 1, 0, 1),
          enabled: isTrackEnabled(track, 'audio'),
          outputDeviceId:
            typeof track.audio?.outputDeviceId === 'string' && track.audio.outputDeviceId
              ? track.audio.outputDeviceId
              : 'project-default',
          sourceChannels,
          channelMap,
        };
      })
      .filter((track) => track.filePath)
  ), [project.tracks]);
  const totalAudioTracksWithSource = useMemo(
    () => project.tracks.filter((track) => track.kind === 'audio' && track.audio?.src).length,
    [project.tracks]
  );
  const useNativeAudioEngine = Boolean(
    nativeAudioStatus.available
    && nativeAudioTrackDescriptors.length > 0
  );
  const nativeAudioTrackMixDescriptors = useMemo(
    () => nativeAudioTrackDescriptors.map((track) => ({
      id: track.id,
      clipStart: track.clipStart,
      volume: track.volume,
      enabled: track.enabled,
    })),
    [nativeAudioTrackDescriptors]
  );

  const resolveNativeOutputId = useCallback((rawOutputId) => {
    const outputId = typeof rawOutputId === 'string' && rawOutputId ? rawOutputId : 'default';
    if (outputId === 'project-default' || outputId === 'default' || outputId.startsWith('native:')) {
      return outputId;
    }
    const browserLabel = audioOutputLabelById.get(outputId) || '';
    const normalizedBrowserLabel = normalizeAudioDeviceName(browserLabel);
    if (!normalizedBrowserLabel) return outputId;
    const matched = nativeAudioDevices.find((device) => {
      const normalizedNativeName = normalizeAudioDeviceName(device?.name || '');
      if (!normalizedNativeName) return false;
      return normalizedNativeName === normalizedBrowserLabel
        || normalizedNativeName.includes(normalizedBrowserLabel)
        || normalizedBrowserLabel.includes(normalizedNativeName);
    });
    return matched ? `native:${matched.id}` : outputId;
  }, [audioOutputLabelById, nativeAudioDevices]);

  useEffect(() => {
    if (!nativeAudioStatus.available) return;
    if (totalAudioTracksWithSource <= 0) return;
    if (nativeAudioTrackDescriptors.length === totalAudioTracksWithSource) return;
    setNativeAudioStatus((prev) => {
      const nextError = 'Some audio tracks are not cached for native playback. Re-import audio files once.';
      if (prev.error === nextError) return prev;
      return { ...prev, error: nextError };
    });
  }, [nativeAudioStatus.available, totalAudioTracksWithSource, nativeAudioTrackDescriptors.length]);

  const configureNativeAudioEngine = useCallback(async () => {
    if (!useNativeAudioEngine) return;
    const bridge = window.oscDaw;
    if (!bridge?.configureNativeAudio || !bridge?.setNativeAudioTracks) return;
    const explicitTrackOutputs = nativeAudioTrackDescriptors
      .map((track) => resolveNativeOutputId(track.outputDeviceId))
      .filter((id) => typeof id === 'string' && id && id !== 'project-default');
    const outputId = explicitTrackOutputs[0] || resolveNativeOutputId(project.audio?.outputDeviceId || 'default');
    let outputLabel = audioOutputLabelById.get(outputId) || '';
    let nativeOutputHint = outputId;
    if (typeof outputId === 'string' && outputId.startsWith('native:')) {
      const numericId = Number(outputId.slice('native:'.length));
      if (Number.isFinite(numericId)) {
        nativeOutputHint = numericId;
      }
      if (!outputLabel) {
        outputLabel = nativeAudioDevices.find((device) => `native:${device.id}` === outputId)?.name || '';
      }
    }
    const highestMappedChannel = nativeAudioTrackDescriptors.reduce((maxValue, track) => {
      const localMax = track.channelMap.reduce((innerMax, value) => {
        const mapped = Math.round(Number(value) || 0);
        if (!Number.isFinite(mapped) || mapped <= 0) return innerMax;
        return Math.max(innerMax, mapped);
      }, track.sourceChannels || 2);
      return Math.max(maxValue, localMax);
    }, 2);
    const outputChannels = clamp(highestMappedChannel, 2, MAX_AUDIO_CHANNELS);
    const configPayload = {
      outputId,
      outputLabel,
      outputHint: nativeOutputHint,
      sampleRate: clamp(Number(project.audio?.sampleRate) || 48000, 8000, 192000),
      bufferFrames: Number(project.audio?.bufferSize) || 1024,
      outputChannels,
    };
    const tracksPayload = {
      tracks: nativeAudioTrackDescriptors,
    };
    const nextConfigKey = JSON.stringify({
      config: configPayload,
      tracks: tracksPayload.tracks.map((track) => ({
        id: track.id,
        filePath: track.filePath,
        sourceChannels: track.sourceChannels,
        channelMap: track.channelMap,
      })),
    });
    if (nativeAudioConfigKeyRef.current === nextConfigKey) return;
    if (explicitTrackOutputs.length > 1) {
      setNativeAudioStatus((prev) => ({
        ...prev,
        error: `Native audio currently uses one output device. Using ${outputId}.`,
      }));
    }
    const configureResult = await bridge.configureNativeAudio(configPayload);
    if (!configureResult?.ok) {
      setNativeAudioStatus((prev) => ({
        ...prev,
        error: configureResult?.error || 'Failed to configure native audio output.',
      }));
      return;
    }
    const setTracksResult = await bridge.setNativeAudioTracks(tracksPayload);
    if (!setTracksResult?.ok) {
      setNativeAudioStatus((prev) => ({
        ...prev,
        error: setTracksResult?.error || 'Failed to load audio tracks into native engine.',
      }));
      return;
    }
    const loadedTracks = Math.round(Number(setTracksResult.loadedTracks) || 0);
    if (loadedTracks !== nativeAudioTrackDescriptors.length) {
      setNativeAudioStatus((prev) => ({
        ...prev,
        error: `Native audio loaded ${loadedTracks}/${nativeAudioTrackDescriptors.length} tracks. Please use WAV files.`,
      }));
    } else {
      setNativeAudioStatus((prev) => (prev.error ? { ...prev, error: null } : prev));
    }
    nativeAudioConfigKeyRef.current = nextConfigKey;
    nativeAudioMixKeyRef.current = '';
    if (isPlayingRef.current && bridge?.playNativeAudio) {
      await bridge.playNativeAudio({ playhead: clamp(Number(playheadRef.current) || 0, 0, project.view.length) });
    }
  }, [
    useNativeAudioEngine,
    project.audio?.outputDeviceId,
    project.audio?.sampleRate,
    project.audio?.bufferSize,
    project.view.length,
    audioOutputLabelById,
    nativeAudioDevices,
    nativeAudioTrackDescriptors,
    resolveNativeOutputId,
  ]);

  const syncNativeAudioTrackMix = useCallback(async () => {
    if (!useNativeAudioEngine) return;
    const bridge = window.oscDaw;
    if (!bridge?.updateNativeAudioTrackMix) return;
    const payload = { tracks: nativeAudioTrackMixDescriptors };
    const nextKey = JSON.stringify(payload.tracks);
    if (nativeAudioMixKeyRef.current === nextKey) return;
    const result = await bridge.updateNativeAudioTrackMix(payload);
    if (!result?.ok) return;
    nativeAudioMixKeyRef.current = nextKey;
  }, [useNativeAudioEngine, nativeAudioTrackMixDescriptors]);

  const seekNativeAudioEngine = useCallback((time) => {
    if (!useNativeAudioEngine) return;
    const bridge = window.oscDaw;
    if (!bridge?.seekNativeAudio) return;
    bridge.seekNativeAudio({ playhead: clamp(Number(time) || 0, 0, project.view.length) }).catch(() => {});
  }, [useNativeAudioEngine, project.view.length]);

  const playNativeAudioEngine = useCallback((time) => {
    if (!useNativeAudioEngine) return;
    const bridge = window.oscDaw;
    if (!bridge?.playNativeAudio) return;
    bridge.playNativeAudio({ playhead: clamp(Number(time) || 0, 0, project.view.length) }).catch(() => {});
  }, [useNativeAudioEngine, project.view.length]);

  const pauseNativeAudioEngine = useCallback(() => {
    if (!useNativeAudioEngine) return;
    const bridge = window.oscDaw;
    if (!bridge?.pauseNativeAudio) return;
    bridge.pauseNativeAudio().catch(() => {});
  }, [useNativeAudioEngine]);

  const applyAudioOutput = async (track, audio) => {
    if (!audio || typeof audio.setSinkId !== 'function') return;
    const deviceId = resolveTrackOutputDeviceId(track);
    try {
      await audio.setSinkId(deviceId);
    } catch (error) {
      // Ignore sink selection errors (unsupported or permission denied).
    }
  };

  const syncAudioToPlayhead = (time) => {
    if (useNativeAudioEngine) {
      seekNativeAudioEngine(time);
    }
    project.tracks.forEach((track) => {
      if (track.kind !== 'audio' || !track.audio?.src) return;
      const audio = getAudioElement(track);
      if (!audio) return;
      audio.pause();
      const timing = getAudioTrackTiming(track, audio, time);
      if (timing.localTime <= 0) {
        seekAudioElement(track, audio, 0);
        return;
      }
      if (timing.localTime >= timing.duration) {
        seekAudioElement(track, audio, Math.max(timing.duration - 0.001, 0));
        return;
      }
      seekAudioElement(track, audio, timing.localTime);
    });
  };

  const resumeAudioEngines = () => {
    if (audioContextRef.current?.state === 'suspended' && typeof audioContextRef.current.resume === 'function') {
      audioContextRef.current.resume().catch(() => {});
    }
    audioRoutingRef.current.forEach((routing) => {
      const context = routing?.context;
      if (!context || context.state !== 'suspended' || typeof context.resume !== 'function') return;
      context.resume().catch(() => {});
    });
  };

  const handleAudioFile = async (trackId, file) => {
    if (!file) return;
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track) return;
    if ((file.size || 0) <= 0) {
      window.alert('Audio file is empty (0 bytes). Please fully download/export the file first.');
      return;
    }
    const previousUrl = audioUrlRef.current.get(trackId);
    const blobSrc = URL.createObjectURL(file);
    let nativePath = typeof file.path === 'string' ? file.path : '';
    const mediaSrc = blobSrc;
    if (!mediaSrc) return;
    audioUrlRef.current.set(trackId, blobSrc);
    if (typeof previousUrl === 'string' && previousUrl.startsWith('blob:') && previousUrl !== blobSrc) {
      window.setTimeout(() => {
        URL.revokeObjectURL(previousUrl);
      }, 30000);
    }
    pendingSeekRef.current.delete(trackId);
    const initialDuration =
      (Number.isFinite(track.audio?.duration) && track.audio.duration > 0
        ? track.audio.duration
        : project.view.length) || 1;
    let sourceChannels = clamp(Math.round(Number(track.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS);
    const initialSampleCount = getWaveformSampleCount(initialDuration);
    const placeholderPeaks = createSilentPeaks(initialSampleCount);
    setAudioWaveforms((prev) => ({
      ...prev,
      [trackId]: { peaks: placeholderPeaks, duration: initialDuration },
    }));
    dispatch({
      type: 'update-track',
      id: trackId,
      patch: {
        audio: {
          src: mediaSrc,
          nativePath,
          name: file.name,
          duration: initialDuration,
          channels: sourceChannels,
          waveformPeaks: placeholderPeaks,
          waveformDuration: initialDuration,
        },
      },
    });

    const existingAudio = audioElementsRef.current.get(trackId);
    if (existingAudio) {
      existingAudio.pause();
      existingAudio.removeAttribute('src');
      existingAudio.load();
      audioElementsRef.current.delete(trackId);
    }
    const preparedTrack = {
      ...track,
      audio: {
        ...(track.audio || {}),
        src: mediaSrc,
        duration: initialDuration,
      },
    };
    const preparedAudio = getAudioElement(preparedTrack);
    if (preparedAudio) {
      preparedAudio.load();
    }

    let arrayBuffer = null;
    try {
      arrayBuffer = await file.arrayBuffer();
    } catch (error) {
      arrayBuffer = null;
    }

    const bridge = window.oscDaw;
    if (arrayBuffer && arrayBuffer.byteLength > 0 && bridge?.cacheNativeAudioFile) {
      try {
        const cached = await bridge.cacheNativeAudioFile({
          name: file.name,
          bytes: new Uint8Array(arrayBuffer),
        });
        if (cached?.ok && typeof cached.path === 'string' && cached.path) {
          nativePath = cached.path;
        }
      } catch (error) {
        // Keep original path fallback when caching fails.
      }
    }

    if (blobSrc && audioUrlRef.current.get(trackId) !== blobSrc) {
      return;
    }

    let duration = initialDuration;
    let peaks = createSilentPeaks(initialSampleCount);
    if (arrayBuffer && arrayBuffer.byteLength > 0) {
      const wavResult = computeWavLeftPeaks(arrayBuffer, getWaveformSampleCount(duration));
      if (wavResult?.peaks?.length) {
        peaks = wavResult.peaks;
        if (wavResult.duration > 0) {
          duration = wavResult.duration;
        }
        if (Number.isFinite(wavResult.channels) && wavResult.channels > 0) {
          sourceChannels = clamp(Math.round(wavResult.channels), 1, MAX_AUDIO_CHANNELS);
        }
      }
    }

    if (arrayBuffer && arrayBuffer.byteLength > 0) {
      try {
        const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
        if (AudioContextImpl) {
          const context = audioContextRef.current || new AudioContextImpl();
          audioContextRef.current = context;
          if (context.state === 'suspended' && typeof context.resume === 'function') {
            context.resume().catch(() => {});
          }
          const audioBuffer = await decodeAudioBuffer(context, arrayBuffer);
          if (audioBuffer?.duration > 0) {
            duration = audioBuffer.duration;
          }
          if (Number.isFinite(audioBuffer?.numberOfChannels) && audioBuffer.numberOfChannels > 0) {
            sourceChannels = clamp(Math.round(audioBuffer.numberOfChannels), 1, MAX_AUDIO_CHANNELS);
          }
          const decodedPeaks = computePeaks(audioBuffer, getWaveformSampleCount(duration));
          if (decodedPeaks.length) {
            peaks = decodedPeaks;
          }
        }
      } catch (error) {
        // Keep WAV-parser waveform fallback when decode fails.
      }
    }

    if (!Array.isArray(peaks) || peaks.length < 2) {
      peaks = createSilentPeaks(getWaveformSampleCount(duration));
    }

    if (blobSrc && audioUrlRef.current.get(trackId) !== blobSrc) {
      return;
    }

    setAudioWaveforms((prev) => ({
      ...prev,
      [trackId]: { peaks, duration },
    }));
    dispatch({
      type: 'update-track',
      id: trackId,
      patch: {
        audio: {
          src: mediaSrc,
          nativePath,
          name: file.name,
          duration,
          channels: sourceChannels,
          waveformPeaks: peaks,
          waveformDuration: duration,
        },
      },
    });

    const clipStart = Math.max(Number(track.audio?.clipStart) || 0, 0);
    const requiredProjectLength = clipStart + Math.max(Number(duration) || 0, 0) + AUDIO_IMPORT_PROJECT_PADDING_SECONDS;
    const currentProjectLength = Math.max(Number(project.view.length) || 0, 0);
    if (requiredProjectLength > currentProjectLength + 0.0001) {
      dispatch({
        type: 'update-project',
        patch: {
          view: {
            length: requiredProjectLength,
          },
        },
      });
    }
  };

  useEffect(() => {
    if (!isPlaying || project.timebase.sync !== 'Internal') {
      lastTickRef.current = null;
      stopInternalClock();
      return;
    }
    if (!internalClockRef.current.running) {
      startInternalClock(playheadRef.current);
    }
    let rafId;
    const tick = (now) => {
      const elapsed = Math.max((now - internalClockRef.current.startPerf) / 1000, 0);
      setPlayhead((prev) => {
        const span = project.view.end - project.view.start;
        const loopEnabled = Boolean(project.view.loopEnabled);
        const loopStart = clamp(Number(project.view.loopStart) || 0, 0, project.view.length);
        const loopEnd = clamp(Number(project.view.loopEnd) || 0, 0, project.view.length);
        const loopSpan = Math.max(loopEnd - loopStart, 0);
        let next = internalClockRef.current.startPlayhead + elapsed;
        if (loopEnabled && loopSpan > 0.0001 && next >= loopStart) {
          if (next >= loopEnd) {
            next = loopStart + ((next - loopStart) % loopSpan);
          }
        } else if (next >= project.view.length) {
          next = project.view.length;
          setIsPlaying(false);
          stopInternalClock();
        }
        if (next > project.view.end || next < project.view.start) {
          const targetStart = clamp(
            next - span * 0.25,
            0,
            Math.max(project.view.length - span, 0)
          );
          dispatch({ type: 'scroll-time', start: targetStart });
        }
        return next;
      });
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(rafId);
    };
  }, [
    isPlaying,
    project.timebase.sync,
    project.view.end,
    project.view.start,
    project.view.length,
    project.view.loopEnabled,
    project.view.loopStart,
    project.view.loopEnd,
  ]);

  useEffect(() => {
    if (project.timebase.sync !== 'MTC') return undefined;
    let rafId = 0;
    const tick = () => {
      const pll = mtcPllRef.current;
      const now = performance.now();
      const predicted = predictMtcPllTime(pll, now);
      if (Number.isFinite(predicted)) {
        const nextTime = clamp(predicted, 0, project.view.length);
        setPlayhead((prev) => (Math.abs(prev - nextTime) < 0.0005 ? prev : nextTime));
        const span = Math.max(project.view.end - project.view.start, 1);
        if (nextTime > project.view.end) {
          const targetStart = clamp(
            nextTime - span * 0.75,
            0,
            Math.max(project.view.length - span, 0)
          );
          dispatch({ type: 'scroll-time', start: targetStart });
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [dispatch, project.timebase.sync, project.view.end, project.view.length, project.view.start]);

  useEffect(() => {
    if (useNativeAudioEngine) {
      const audioTracks = project.tracks.filter((track) => track.kind === 'audio' && track.audio?.src);
      audioTracks.forEach((track) => {
        const audio = getAudioElement(track);
        if (!audio) return;
        audio.pause();
      });
      return undefined;
    }
    const audioTracks = project.tracks.filter((track) => track.kind === 'audio' && track.audio?.src);
    audioTracks.forEach((track) => {
      const audio = getAudioElement(track);
      if (!audio) return;
      const enabled = isTrackEnabled(track, 'audio');
      const targetVolume = enabled ? clamp(track.audio?.volume ?? 1, 0, 1) : 0;
      const routing = ensureMappedAudioRouting(track, audio);
      const routingActive = Boolean(routing?.gainNode && routing.context?.state === 'running');
      if (routingActive) {
        try {
          if (!Number.isFinite(audio.volume) || Math.abs(audio.volume - 1) > 0.0001) {
            audio.volume = 1;
          }
          audio.muted = true;
          const gainValue = clamp(targetVolume, 0, 1);
          if (Math.abs((routing.gainNode.gain?.value ?? 0) - gainValue) > 0.0001) {
            routing.gainNode.gain.value = gainValue;
          }
        } catch (error) {
          // Guard against routing assignment errors.
        }
      } else {
        if (routing?.context?.state === 'suspended' && typeof routing.context.resume === 'function') {
          routing.context.resume().catch(() => {});
        }
        applyAudioOutput(track, audio);
        try {
          if (!Number.isFinite(audio.volume) || Math.abs(audio.volume - targetVolume) > 0.0001) {
            audio.volume = targetVolume;
          }
          audio.muted = !enabled;
        } catch (error) {
          // Guard against invalid volume assignments.
        }
      }
      if (isPlaying) {
        const timing = getAudioTrackTiming(track, audio, playhead);
        if (!timing.inRange) {
          if (timing.localTime <= 0) {
            seekAudioElement(track, audio, 0);
          } else {
            seekAudioElement(track, audio, Math.max(timing.duration - 0.001, 0));
          }
          audio.pause();
        } else {
          const safeLocalTime = clamp(timing.localTime, 0, Math.max(timing.duration - 0.001, 0));
          const drift = Math.abs(audio.currentTime - safeLocalTime);
          if (Number.isFinite(drift) && drift > 0.25) {
            seekAudioElement(track, audio, safeLocalTime);
          }
          if (audio.paused) {
            const result = audio.play();
            if (result && typeof result.catch === 'function') {
              result.catch(() => {});
            }
          }
        }
      } else {
        audio.pause();
      }
    });
  }, [isPlaying, playhead, project.tracks, project.audio?.outputDeviceId, useNativeAudioEngine]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const fps = Math.max(Number(project.timebase.fps) || 30, 1);
    const tickMs = Math.max(1000 / fps, 4);
    const outputs = normalizeOscOutputsForUi(project.osc);
    const defaultOutput = outputs[0] || {
      id: DEFAULT_OSC_OUTPUT_ID,
      name: 'Main',
      host: '127.0.0.1',
      port: 9000,
    };
    const outputMap = new Map(outputs.map((output) => [output.id, output]));
    const resolveOutput = (track) => {
      if (!track) return defaultOutput;
      const outputId = typeof track.oscOutputId === 'string' && track.oscOutputId
        ? track.oscOutputId
        : defaultOutput.id;
      return outputMap.get(outputId) || defaultOutput;
    };
    const sendOscFrame = () => {
      const bridge = window.oscDaw;
      if (!bridge || typeof bridge.sendOscMessage !== 'function') return;
      project.tracks.forEach((track) => {
        if (track.mute) return;
        const address = typeof track.oscAddress === 'string' ? track.oscAddress.trim() : '';
        if (!address) return;
        const output = resolveOutput(track);
        const host = output.host || '127.0.0.1';
        const port = Number(output.port) || 9000;
        if (track.kind === 'osc') {
          if (!isTrackEnabled(track, 'osc')) return;
          const valueType = getOscSendValueType(track);
          const value = formatOscOutputScalar(sampleTrackValue(track, playheadRef.current), valueType);
          bridge.sendOscMessage({ host, port, address, value, valueType });
          return;
        }
        if (track.kind === 'osc-array') {
          if (!isTrackEnabled(track, 'osc-array')) return;
          const valueType = getOscSendValueType(track);
          const values = formatOscOutputArray(
            sampleOscArrayTrackValues(track, playheadRef.current, project.timebase?.fps),
            valueType
          );
          bridge.sendOscMessage({ host, port, address, value: values, valueType });
          return;
        }
        if (track.kind === 'osc-3d') {
          if (!isTrackEnabled(track, 'osc-3d')) return;
          const valueType = getOscSendValueType(track);
          const values = formatOscOutputArray(
            sampleOsc3dTrackValues(track, playheadRef.current, project.timebase?.fps),
            valueType
          );
          bridge.sendOscMessage({ host, port, address, value: values, valueType });
        }
      });
    };
    sendOscFrame();
    const intervalId = window.setInterval(sendOscFrame, tickMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPlaying, project.timebase.fps, project.tracks, project.osc]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const fps = Math.max(Number(project.timebase.fps) || 30, 1);
    const tickMs = Math.max(1000 / fps, 4);
    const outputs = normalizeOscOutputsForUi(project.osc);
    const defaultOutput = outputs[0] || {
      id: DEFAULT_OSC_OUTPUT_ID,
      name: 'Main',
      host: '127.0.0.1',
      port: 9000,
    };
    const outputMap = new Map(outputs.map((output) => [output.id, output]));
    const resolveOutput = (track) => {
      if (!track) return defaultOutput;
      const outputId = typeof track.oscOutputId === 'string' && track.oscOutputId
        ? track.oscOutputId
        : defaultOutput.id;
      return outputMap.get(outputId) || defaultOutput;
    };
    const sendOscColorFrame = () => {
      const bridge = window.oscDaw;
      if (!bridge || typeof bridge.sendOscMessage !== 'function') return;
      const currentTime = playheadRef.current;
      project.tracks.forEach((track) => {
        if (track.kind !== 'osc-color') return;
        if (track.mute) return;
        if (!isTrackEnabled(track, 'osc-color')) return;
        const output = resolveOutput(track);
        const host = output.host || '127.0.0.1';
        const port = Number(output.port) || 9000;
        const writes = resolveOscColorWrites(track, currentTime);
        writes.forEach((write) => {
          if (!write?.address) return;
          const payloadValue = Array.isArray(write.values)
            ? write.values
            : (Array.isArray(write.value) ? write.value : [Number(write.value) || 0]);
          bridge.sendOscMessage({
            host,
            port,
            address: write.address,
            value: payloadValue,
          });
        });
      });
    };
    sendOscColorFrame();
    const intervalId = window.setInterval(sendOscColorFrame, tickMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPlaying, project.timebase.fps, project.tracks, project.osc]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const fps = Math.max(Number(project.timebase.fps) || 30, 1);
    const tickMs = Math.max(1000 / fps, 4);
    const epsilon = 0.5 / fps;
    const outputs = normalizeOscOutputsForUi(project.osc);
    const defaultOutput = outputs[0] || {
      id: DEFAULT_OSC_OUTPUT_ID,
      name: 'Main',
      host: '127.0.0.1',
      port: 9000,
    };
    const outputMap = new Map(outputs.map((output) => [output.id, output]));
    const resolveOutput = (track) => {
      if (!track) return defaultOutput;
      const outputId = typeof track.oscOutputId === 'string' && track.oscOutputId
        ? track.oscOutputId
        : defaultOutput.id;
      return outputMap.get(outputId) || defaultOutput;
    };

    const sendOscFlagEvents = () => {
      const bridge = window.oscDaw;
      if (!bridge || typeof bridge.sendOscMessage !== 'function') return;
      const projectLength = Math.max(Number(project.view.length) || 0, 0);
      const currentTime = clamp(Number(playheadRef.current) || 0, 0, projectLength);
      const rawPrevTime = Number(oscFlagPlaybackRef.current.lastTime);
      const hasPrevTime = Number.isFinite(rawPrevTime);
      const prevTime = hasPrevTime ? clamp(rawPrevTime, 0, projectLength) : currentTime;
      const maxContinuousStep = Math.max((tickMs / 1000) * 4, 0.12);

      const loopEnabled = Boolean(project.view.loopEnabled);
      const loopStart = clamp(Number(project.view.loopStart) || 0, 0, projectLength);
      const loopEnd = clamp(Number(project.view.loopEnd) || projectLength, 0, projectLength);

      const ranges = [];
      const pushRange = (start, end, includeStart) => {
        if (!Number.isFinite(start) || !Number.isFinite(end)) return;
        const safeStart = clamp(Math.min(start, end), 0, projectLength);
        const safeEnd = clamp(Math.max(start, end), 0, projectLength);
        ranges.push({ start: safeStart, end: safeEnd, includeStart: Boolean(includeStart) });
      };

      if (!hasPrevTime) {
        pushRange(currentTime, currentTime, true);
      } else if (currentTime >= prevTime) {
        if (currentTime - prevTime > maxContinuousStep) {
          pushRange(currentTime, currentTime, true);
        } else {
          pushRange(prevTime, currentTime, false);
        }
      } else if (loopEnabled && loopEnd - loopStart > epsilon) {
        pushRange(prevTime, loopEnd, false);
        pushRange(loopStart, currentTime, true);
      } else {
        pushRange(currentTime, currentTime, true);
      }

      const isTriggered = (nodeTime) => ranges.some((range) => {
        if (range.includeStart) {
          return nodeTime >= range.start - epsilon && nodeTime <= range.end + epsilon;
        }
        return nodeTime > range.start + epsilon && nodeTime <= range.end + epsilon;
      });

      const isTimeWithinRange = (time, start, end, includeStart = true) => {
        if (includeStart) return time >= start - epsilon && time <= end + epsilon;
        return time > start + epsilon && time <= end + epsilon;
      };

      project.tracks.forEach((track) => {
        if (track.kind !== 'osc-flag') return;
        if (track.mute) return;
        if (!isTrackEnabled(track, 'osc-flag')) return;
        const valueType = getOscSendValueType(track);
        const output = resolveOutput(track);
        const host = output.host || '127.0.0.1';
        const port = Number(output.port) || 9000;
        const fallbackAddress = normalizeOscAddressPath(track.oscAddress, '/osc/flag');
        const nodes = Array.isArray(track.nodes) ? track.nodes : [];
        nodes.forEach((node) => {
          const triggerStart = Number(node?.t);
          if (!Number.isFinite(triggerStart)) return;
          const triggerDuration = Math.max(Number(node?.d) || 1, 0);
          const triggerValueRaw = Number.isFinite(Number(node?.v)) ? Number(node.v) : 1;
          const triggerValue = formatOscOutputScalar(triggerValueRaw, valueType);

          const isStartTriggered = isTriggered(triggerStart);
          const inActiveWindow = triggerDuration > epsilon
            && isTimeWithinRange(currentTime, triggerStart, triggerStart + triggerDuration, true);
          if (!isStartTriggered && !inActiveWindow) return;

          const baseAddress = normalizeOscAddressPath(node?.a, fallbackAddress).replace(/\/+$/, '');
          const valueText = String(triggerValue);
          const address = `${baseAddress}/${valueText}`;
          bridge.sendOscMessage({ host, port, address, value: triggerValue, valueType });
        });
      });

      oscFlagPlaybackRef.current.lastTime = currentTime;
    };

    sendOscFlagEvents();
    const intervalId = window.setInterval(sendOscFlagEvents, tickMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    isPlaying,
    project.timebase.fps,
    project.tracks,
    project.view.length,
    project.view.loopEnabled,
    project.view.loopStart,
    project.view.loopEnd,
    project.osc,
  ]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const bridge = window.oscDaw;
    if (!bridge || typeof bridge.sendArtNetFrame !== 'function') return undefined;
    const fps = Math.max(Number(project.timebase.fps) || 30, 1);
    const tickMs = Math.max(1000 / fps, 4);

    const sendDmxFrame = () => {
      const groups = new Map();
      const currentTime = playheadRef.current;

      project.tracks.forEach((track) => {
        if (track.mute) return;
        if (track.kind !== 'dmx' && track.kind !== 'dmx-color') return;
        if (!isTrackEnabled(track, track.kind)) return;

        const host = track.kind === 'dmx-color'
          ? (
            typeof track.dmxColor?.host === 'string' && track.dmxColor.host.trim()
              ? track.dmxColor.host.trim()
              : '127.0.0.1'
          )
          : (
            typeof track.dmx?.host === 'string' && track.dmx.host.trim()
              ? track.dmx.host.trim()
              : '127.0.0.1'
          );
        const universe = track.kind === 'dmx-color'
          ? clamp(Math.round(Number(track.dmxColor?.universe) || 0), 0, 32767)
          : clamp(Math.round(Number(track.dmx?.universe) || 0), 0, 32767);
        const sampled = sampleTrackValue(track, currentTime);
        const writes = track.kind === 'dmx-color'
          ? resolveDmxColorWrites(track, currentTime)
          : [[clamp(Math.round(Number(track.dmx?.channel) || 1), 1, 512), clamp(Math.round(sampled), 0, 255)]];
        const key = `${host}|${universe}`;
        let group = groups.get(key);
        if (!group) {
          group = { host, universe, data: new Uint8Array(512) };
          groups.set(key, group);
        }
        writes.forEach(([channel, value]) => {
          if (!Number.isFinite(channel) || channel < 1 || channel > 512) return;
          group.data[channel - 1] = clamp(Math.round(Number(value) || 0), 0, 255);
        });
      });

      const sequenceMap = artNetSequenceRef.current;
      const activeKeys = new Set(groups.keys());
      sequenceMap.forEach((_value, key) => {
        if (!activeKeys.has(key)) sequenceMap.delete(key);
      });

      groups.forEach((group, key) => {
        const nextSequence = ((sequenceMap.get(key) || 0) + 1) & 0xff;
        sequenceMap.set(key, nextSequence);
        bridge.sendArtNetFrame({
          host: group.host,
          port: ARTNET_PORT,
          universe: group.universe,
          sequence: nextSequence,
          data: Array.from(group.data),
        }).catch(() => {});
      });
    };

    sendDmxFrame();
    const intervalId = window.setInterval(sendDmxFrame, tickMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPlaying, project.timebase.fps, project.tracks]);

  useEffect(() => {
    if (!isPlaying) return undefined;
    const fps = Math.max(Number(project.timebase.fps) || 30, 1);
    const tickMs = Math.max(1000 / fps, 4);
    const minNoteDuration = 1 / fps;

    const sendMidiBytes = (outputId, bytes) => {
      const targetId = typeof outputId === 'string' && outputId ? outputId : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID);
      const safeBytes = Array.isArray(bytes)
        ? bytes
          .map((value) => Number(value))
          .filter((value) => Number.isFinite(value))
          .map((value) => Math.max(0, Math.min(255, Math.round(value))))
        : [];
      if (!safeBytes.length) return false;

      if (targetId === VIRTUAL_MIDI_OUTPUT_ID) {
        const bridge = window.oscDaw;
        if (!bridge?.sendVirtualMidiMessage) return false;
        bridge.sendVirtualMidiMessage({ bytes: safeBytes }).catch(() => {});
        return true;
      }

      const accessOutput = midiAccessRef.current?.outputs?.get(targetId) || null;
      const fallbackOutput =
        targetId === (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID) && midiOutputRef.current
          ? midiOutputRef.current
          : null;
      const output = accessOutput || fallbackOutput;
      if (!output || typeof output.send !== 'function') return false;
      try {
        if (typeof output.open === 'function') {
          output.open().catch(() => {});
        }
        output.send(safeBytes);
        return true;
      } catch (error) {
        return false;
      }
    };

    const ccRuntime = midiTrackRuntimeRef.current;
    const noteRuntime = midiNoteRuntimeRef.current;
    const sendNoteOff = (state) => {
      const channel = Math.max(0, Math.min(15, Math.round(Number(state?.channel) || 0)));
      const noteNumber = Math.max(0, Math.min(127, Math.round(Number(state?.note) || 0)));
      const outputId = typeof state?.outputId === 'string' && state.outputId
        ? state.outputId
        : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID);
      sendMidiBytes(outputId, [0x80 | channel, noteNumber, 0]);
    };

    const sendTick = () => {
      const currentTime = playheadRef.current;
      const activeCcTrackIds = new Set();
      project.tracks.forEach((track) => {
        if (track.kind !== 'midi') return;
        if (track.mute) return;
        activeCcTrackIds.add(track.id);
        const outputId = getMidiTrackOutputId(track);
        const channel = Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1))) - 1;
        const enabled = isTrackEnabled(track, 'midi');
        if (!enabled) return;
        const state = ccRuntime.get(track.id) || { lastCc: null };
        const controlNumber = Math.max(0, Math.min(127, Math.round(Number(track.midi?.controlNumber) || 1)));
        const ccValue = Math.max(0, Math.min(127, Math.round(sampleTrackValue(track, currentTime))));
        if (state.lastCc === ccValue) return;
        sendMidiBytes(outputId, [0xb0 | channel, controlNumber, ccValue]);
        ccRuntime.set(track.id, { ...state, lastCc: ccValue });
      });

      ccRuntime.forEach((_state, trackId) => {
        if (activeCcTrackIds.has(trackId)) return;
        ccRuntime.delete(trackId);
      });

      const activeNoteKeys = new Set();
      project.tracks.forEach((track) => {
        if (track.kind !== 'midi-note') return;
        if (track.mute) return;
        if (!isTrackEnabled(track, 'midi-note')) return;
        const outputId = getMidiTrackOutputId(track);
        const channel = Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1))) - 1;
        const velocity = Math.max(0, Math.min(127, Math.round(Number(track.midi?.velocity) || 100)));
        const nodes = Array.isArray(track.nodes) ? track.nodes : [];
        nodes.forEach((node) => {
          const start = Number(node?.t);
          if (!Number.isFinite(start)) return;
          const duration = Math.max(Number(node?.d) || 0.5, minNoteDuration);
          const end = start + duration;
          if (currentTime < start || currentTime >= end) return;
          const noteNumber = Math.max(0, Math.min(127, Math.round(Number(node?.v) || 60)));
          const key = `${track.id}:${node.id}`;
          activeNoteKeys.add(key);
          if (noteRuntime.has(key)) return;
          const sent = sendMidiBytes(outputId, [0x90 | channel, noteNumber, velocity]);
          if (!sent) return;
          noteRuntime.set(key, {
            outputId,
            channel,
            note: noteNumber,
          });
        });
      });

      noteRuntime.forEach((state, key) => {
        if (activeNoteKeys.has(key)) return;
        sendNoteOff(state);
        noteRuntime.delete(key);
      });
    };

    sendTick();
    const intervalId = window.setInterval(sendTick, tickMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [isPlaying, project.midi?.outputId, project.timebase.fps, project.tracks]);

  useEffect(() => {
    if (isPlaying) return;
    const noteRuntime = midiNoteRuntimeRef.current;
    if (noteRuntime.size) {
      noteRuntime.forEach((state) => {
        const channel = Math.max(0, Math.min(15, Math.round(Number(state?.channel) || 0)));
        const noteNumber = Math.max(0, Math.min(127, Math.round(Number(state?.note) || 0)));
        const outputId = typeof state?.outputId === 'string' && state.outputId
          ? state.outputId
          : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID);
        if (outputId === VIRTUAL_MIDI_OUTPUT_ID) {
          const bridge = window.oscDaw;
          bridge?.sendVirtualMidiMessage?.({ bytes: [0x80 | channel, noteNumber, 0] }).catch(() => {});
        } else {
          const output = midiAccessRef.current?.outputs?.get(outputId) || null;
          try {
            output?.send?.([0x80 | channel, noteNumber, 0]);
          } catch (error) {
            // Ignore note-off send failures.
          }
        }
      });
      noteRuntime.clear();
    }
    midiTrackRuntimeRef.current.clear();
  }, [isPlaying, project.tracks, project.midi?.outputId]);

  useEffect(() => {
    const noteRuntime = midiNoteRuntimeRef.current;
    if (noteRuntime.size) {
      const activeNoteTrackIds = new Set(
        project.tracks.filter((track) => track.kind === 'midi-note').map((track) => track.id)
      );
      noteRuntime.forEach((state, key) => {
        const [trackId] = String(key).split(':');
        if (activeNoteTrackIds.has(trackId)) return;
        const channel = Math.max(0, Math.min(15, Math.round(Number(state?.channel) || 0)));
        const noteNumber = Math.max(0, Math.min(127, Math.round(Number(state?.note) || 0)));
        const outputId = typeof state?.outputId === 'string' && state.outputId
          ? state.outputId
          : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID);
        if (outputId === VIRTUAL_MIDI_OUTPUT_ID) {
          const bridge = window.oscDaw;
          bridge?.sendVirtualMidiMessage?.({ bytes: [0x80 | channel, noteNumber, 0] }).catch(() => {});
        } else {
          const output = midiAccessRef.current?.outputs?.get(outputId) || null;
          try {
            output?.send?.([0x80 | channel, noteNumber, 0]);
          } catch (error) {
            // Ignore note-off failures while removing tracks.
          }
        }
        noteRuntime.delete(key);
      });
    }

    const ccRuntime = midiTrackRuntimeRef.current;
    if (!ccRuntime.size) return;
    const activeCcTrackIds = new Set(
      project.tracks.filter((track) => track.kind === 'midi').map((track) => track.id)
    );
    ccRuntime.forEach((_state, trackId) => {
      if (activeCcTrackIds.has(trackId)) return;
      ccRuntime.delete(trackId);
    });
  }, [project.tracks, project.midi?.outputId]);

  useEffect(() => {
    const syncMode = project.timebase?.sync || 'Internal';
    if (syncMode !== 'Internal') return undefined;
    if (!isPlaying) return undefined;

    const bridge = window.oscDaw;
    const selectedOutputId = project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID;
    const preferredOutputId = selectedOutputId;
    const useVirtualOutput =
      preferredOutputId === VIRTUAL_MIDI_OUTPUT_ID
      && bridge
      && typeof bridge.sendVirtualMidiMessage === 'function';

    const fps = Math.max(Number(syncFpsPreset.fps) || 30, 1);
    const mtcRateCode = syncFpsPreset.mtcRateCode;
    const mtcFrameBase = mtcRateCode === 0 ? 24 : (mtcRateCode === 1 ? 25 : 30);
    const stepMs = Math.max(1000 / (fps * 4), 6);
    let quarterFrameIndex = 0;
    let canSendFullFrame = useVirtualOutput || Boolean(midiAccessRef.current?.sysexEnabled);
    let lastFullFrameAt = 0;

    const toTimecode = (timeSec) => {
      const safeSeconds = Math.max(Number(timeSec) || 0, 0);
      const wholeSeconds = Math.floor(safeSeconds);
      const fractional = safeSeconds - wholeSeconds;
      const frames = Math.min(Math.floor(fractional * mtcFrameBase), mtcFrameBase - 1);
      const seconds = wholeSeconds % 60;
      const minutes = Math.floor(wholeSeconds / 60) % 60;
      const hours = Math.floor(wholeSeconds / 3600) % 24;
      return { hours, minutes, seconds, frames };
    };

    const getOutput = () => {
      if (!preferredOutputId || preferredOutputId === VIRTUAL_MIDI_OUTPUT_ID) return null;
      const fromAccess = midiAccessRef.current?.outputs?.get(preferredOutputId) || null;
      if (fromAccess && typeof fromAccess.send === 'function') return fromAccess;
      if (midiOutputRef.current && typeof midiOutputRef.current.send === 'function') return midiOutputRef.current;
      return null;
    };

    const sendVirtual = (bytes) => {
      if (!useVirtualOutput || !bridge?.sendVirtualMidiMessage) return false;
      bridge.sendVirtualMidiMessage({ bytes }).catch(() => {});
      return true;
    };

    const sendToOutput = (bytes) => {
      if (sendVirtual(bytes)) return true;
      const output = getOutput();
      if (!output) return false;
      try {
        output.send(bytes);
        return true;
      } catch (error) {
        return false;
      }
    };

    const buildFullFrame = (tc) => {
      const hourByte = ((mtcRateCode & 0x03) << 5) | (tc.hours & 0x1f);
      return [0xf0, 0x7f, 0x7f, 0x01, 0x01, hourByte, tc.minutes & 0x3f, tc.seconds & 0x3f, tc.frames & 0x1f, 0xf7];
    };

    const sendMtcTick = () => {
      const tc = toTimecode(playheadRef.current);
      const now = performance.now();
      if (canSendFullFrame && (lastFullFrameAt === 0 || now - lastFullFrameAt >= 1000)) {
        const ok = sendToOutput(buildFullFrame(tc));
        if (ok) {
          lastFullFrameAt = now;
        } else if (!useVirtualOutput) {
          canSendFullFrame = false;
        }
      }
      const values = [
        tc.frames & 0x0f,
        (tc.frames >> 4) & 0x01,
        tc.seconds & 0x0f,
        (tc.seconds >> 4) & 0x07,
        tc.minutes & 0x0f,
        (tc.minutes >> 4) & 0x07,
        tc.hours & 0x0f,
        ((tc.hours >> 4) & 0x01) | (mtcRateCode << 1),
      ];
      const data1 = ((quarterFrameIndex & 0x07) << 4) | (values[quarterFrameIndex] & 0x0f);
      const ok = sendToOutput([0xf1, data1]);
      if (!ok && !useVirtualOutput) {
        return;
      }
      quarterFrameIndex = (quarterFrameIndex + 1) % 8;
    };

    sendMtcTick();
    const intervalId = window.setInterval(sendMtcTick, stepMs);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    isPlaying,
    project.timebase?.sync,
    project.midi?.outputId,
    midiDevices.outputs,
    syncFpsPreset.fps,
    syncFpsPreset.mtcRateCode,
  ]);

  useEffect(() => {
    const syncMode = project.timebase?.sync || 'Internal';
    if (syncMode !== 'LTC') {
      stopLtcSync();
      return undefined;
    }
    if (!navigator.mediaDevices?.getUserMedia) return undefined;

    let cancelled = false;
    const deviceId = project.audio?.ltc?.inputDeviceId || 'default';
    const channelIndex = Math.max(Number(project.audio?.ltc?.channel) || 1, 1) - 1;
    const AudioContextImpl = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextImpl) return undefined;

    const constraints = {
      audio: {
        deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
        channelCount: { ideal: 2 },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      video: false,
    };

    const setupLtc = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (cancelled) {
          stream.getTracks().forEach((streamTrack) => streamTrack.stop());
          return;
        }
        const context = new AudioContextImpl({ latencyHint: 'interactive' });
        const source = context.createMediaStreamSource(stream);
        const processor = context.createScriptProcessor(2048, source.channelCount || 2, 1);
        const decoder = new LtcDecoder(context.sampleRate);

        decoder.on('frame', (frame) => {
          if (syncMode !== 'LTC') return;
          const frameRate = Math.max(Number(frame?.framerate) || Number(syncFpsPreset.fps) || 30, 1);
          const seconds = clamp(
            (Number(frame?.hours) || 0) * 3600
              + (Number(frame?.minutes) || 0) * 60
              + (Number(frame?.seconds) || 0)
              + (Number(frame?.frames) || 0) / frameRate,
            0,
            project.view.length
          );
          setPlayhead(seconds);
          setIsPlaying(true);
          if (ltcFollowTimeoutRef.current) {
            window.clearTimeout(ltcFollowTimeoutRef.current);
          }
          ltcFollowTimeoutRef.current = window.setTimeout(() => {
            setIsPlaying(false);
          }, 500);
        });

        processor.onaudioprocess = (event) => {
          const inputBuffer = event.inputBuffer;
          if (!inputBuffer) return;
          const maxChannel = Math.max(inputBuffer.numberOfChannels - 1, 0);
          const data = inputBuffer.getChannelData(Math.min(channelIndex, maxChannel));
          if (!data || !data.length) return;
          const samples = new Int8Array(data.length);
          for (let i = 0; i < data.length; i += 1) {
            samples[i] = Math.max(-127, Math.min(127, Math.round(data[i] * 127)));
          }
          decoder.decode(samples);
        };

        const silentGain = context.createGain();
        silentGain.gain.value = 0;
        source.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(context.destination);

        ltcStreamRef.current = stream;
        ltcContextRef.current = context;
        ltcSourceRef.current = source;
        ltcProcessorRef.current = processor;
        ltcDecoderRef.current = decoder;
      } catch (error) {
        if (!cancelled) {
          setIsPlaying(false);
        }
      }
    };

    setupLtc();
    return () => {
      cancelled = true;
      stopLtcSync();
    };
  }, [
    project.timebase?.sync,
    project.view.length,
    project.audio?.ltc?.inputDeviceId,
    project.audio?.ltc?.channel,
    stopLtcSync,
    syncFpsPreset.fps,
  ]);

  useEffect(() => {
    const handleKeydown = (event) => {
      const target = event.target;
      const tag = target?.tagName?.toLowerCase();
      const isPlainEnter = event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      const isPlainArrowDown = event.key === 'ArrowDown' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      const isAudioMapAdvanceKey = Boolean(audioChannelMapTrackId) && (isPlainEnter || isPlainArrowDown);
      if (!isAudioMapAdvanceKey && (tag === 'input' || tag === 'textarea' || target?.isContentEditable)) return;
      if (isHelpOpen) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setIsHelpOpen(false);
        }
        return;
      }
      if (multiAddDialog) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setMultiAddDialog(null);
        }
        return;
      }
      if (audioChannelMapTrackId) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setAudioChannelMapTrackId(null);
          setAudioChannelMapDraft(null);
          return;
        }
        if (isPlainEnter || isPlainArrowDown) {
          event.preventDefault();
          const currentTrack = project.tracks.find(
            (track) => track.id === audioChannelMapTrackId && track.kind === 'audio'
          );
          if (!currentTrack) {
            setAudioChannelMapTrackId(null);
            setAudioChannelMapDraft(null);
            return;
          }
          const outputDeviceId =
            typeof audioChannelMapDraft?.outputDeviceId === 'string' && audioChannelMapDraft.outputDeviceId
              ? audioChannelMapDraft.outputDeviceId
              : (typeof currentTrack.audio?.outputDeviceId === 'string' && currentTrack.audio.outputDeviceId
                ? currentTrack.audio.outputDeviceId
                : 'project-default');
          const sourceChannels = clamp(Math.round(Number(currentTrack.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS);
          const resolvedOutputDeviceId =
            outputDeviceId === 'project-default'
              ? (project.audio?.outputDeviceId || 'default')
              : outputDeviceId;
          const outputChannelCount = getDetectedOutputChannels(resolvedOutputDeviceId);
          const rawChannelMap = Array.isArray(audioChannelMapDraft?.channelMap)
            ? audioChannelMapDraft.channelMap
            : (Array.isArray(currentTrack.audio?.channelMap) ? currentTrack.audio.channelMap : []);
          const channelMap = Array.from({ length: sourceChannels }, (_, index) => {
            const fallback = ((index % outputChannelCount) + 1);
            const value = Math.round(Number(rawChannelMap[index]) || fallback);
            return clamp(value, 1, outputChannelCount);
          });
          dispatch({
            type: 'update-track',
            id: currentTrack.id,
            patch: {
              audio: {
                outputDeviceId,
                channelMapEnabled: true,
                channels: sourceChannels,
                channelMap,
              },
            },
          });
          const audioTrackIds = project.tracks
            .filter((track) => track.kind === 'audio')
            .map((track) => track.id);
          const currentIndex = audioTrackIds.indexOf(currentTrack.id);
          const nextTrackId = currentIndex >= 0 ? audioTrackIds[currentIndex + 1] : null;
          if (!nextTrackId) {
            setAudioChannelMapTrackId(null);
            setAudioChannelMapDraft(null);
            return;
          }
          const nextTrack = project.tracks.find(
            (track) => track.id === nextTrackId && track.kind === 'audio'
          );
          if (!nextTrack) {
            setAudioChannelMapTrackId(null);
            setAudioChannelMapDraft(null);
            return;
          }
          const nextOutputDeviceId =
            typeof nextTrack.audio?.outputDeviceId === 'string' && nextTrack.audio.outputDeviceId
              ? nextTrack.audio.outputDeviceId
              : 'project-default';
          const nextSourceChannels = clamp(Math.round(Number(nextTrack.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS);
          const nextResolvedOutputDeviceId =
            nextOutputDeviceId === 'project-default'
              ? (project.audio?.outputDeviceId || 'default')
              : nextOutputDeviceId;
          const nextOutputChannelCount = getDetectedOutputChannels(nextResolvedOutputDeviceId);
          const nextRaw = Array.isArray(nextTrack.audio?.channelMap) ? nextTrack.audio.channelMap : [];
          const nextChannelMap = Array.from({ length: nextSourceChannels }, (_, index) => {
            const fallback = ((index % nextOutputChannelCount) + 1);
            const value = Math.round(Number(nextRaw[index]) || fallback);
            return clamp(value, 1, nextOutputChannelCount);
          });
          setAudioChannelMapDraft({
            outputDeviceId: nextOutputDeviceId,
            channelMap: nextChannelMap,
          });
          setAudioChannelMapTrackId(nextTrackId);
        }
        return;
      }
      if (editingAudioClip) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setEditingAudioClip(null);
        }
        return;
      }
      const key = event.key?.toLowerCase();
      const withCommand = event.metaKey || event.ctrlKey;
      if (withCommand && key === 's') {
        event.preventDefault();
        handleSave();
        return;
      }
      if (withCommand && key === 'l') {
        event.preventDefault();
        handleLoad();
        return;
      }
      if (withCommand && key === 'c') {
        event.preventDefault();
        const selectedNodeTracks = Array.from(selectedNodeIdsByTrackRef.current.entries())
          .map(([trackId, nodeIds]) => {
            if (!trackId || !Array.isArray(nodeIds) || !nodeIds.length) return null;
            const sourceTrack = project.tracks.find((track) => track.id === trackId);
            if (!sourceTrack || sourceTrack.kind === 'audio' || sourceTrack.kind === 'group') return null;
            if (!Array.isArray(sourceTrack.nodes) || !sourceTrack.nodes.length) return null;
            const nodeSet = new Set(nodeIds);
            const nodes = sourceTrack.nodes
              .filter((node) => nodeSet.has(node.id))
              .map((node) => ({
                id: node.id,
                t: node.t,
                v: node.v,
                arr: Array.isArray(node.arr) ? [...node.arr] : undefined,
                a: node.a,
                d: node.d,
                y: node.y,
                c: node.c,
                curve: node.curve || 'linear',
              }))
              .sort((a, b) => a.t - b.t);
            if (!nodes.length) return null;
            return {
              sourceTrackId: sourceTrack.id,
              kind: sourceTrack.kind,
              nodes,
            };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const aIndex = project.tracks.findIndex((track) => track.id === a.sourceTrackId);
            const bIndex = project.tracks.findIndex((track) => track.id === b.sourceTrackId);
            return aIndex - bIndex;
          });

        if (selectedNodeTracks.length) {
          const allTimes = selectedNodeTracks.flatMap((item) => item.nodes.map((node) => Number(node.t) || 0));
          const baseTime = allTimes.length ? Math.min(...allTimes) : 0;
          clipboardRef.current = {
            type: 'nodes',
            tracks: selectedNodeTracks,
            baseTime,
          };
          return;
        }
        const trackIdSet = new Set(project.tracks.map((track) => track.id));
        const targetTrackIds = selectedTrackIds.filter((id) => trackIdSet.has(id));
        const copyIds = targetTrackIds.length
          ? targetTrackIds
          : (selectedTrackId && trackIdSet.has(selectedTrackId) ? [selectedTrackId] : []);
        if (!copyIds.length) return;
        const copyIdSet = new Set(copyIds);
        const tracks = project.tracks
          .filter((track) => copyIdSet.has(track.id))
          .map((track) => JSON.parse(JSON.stringify(track)));
        if (!tracks.length) return;
        clipboardRef.current = { type: 'tracks', tracks };
        return;
      }
      if (withCommand && key === 'x') {
        event.preventDefault();
        const selectedNodeTracks = Array.from(selectedNodeIdsByTrackRef.current.entries())
          .map(([trackId, nodeIds]) => {
            if (!trackId || !Array.isArray(nodeIds) || !nodeIds.length) return null;
            const sourceTrack = project.tracks.find((track) => track.id === trackId);
            if (!sourceTrack || sourceTrack.kind === 'audio' || sourceTrack.kind === 'group') return null;
            if (!Array.isArray(sourceTrack.nodes) || !sourceTrack.nodes.length) return null;
            const nodeSet = new Set(nodeIds);
            const nodes = sourceTrack.nodes
              .filter((node) => nodeSet.has(node.id))
              .map((node) => ({
                id: node.id,
                t: node.t,
                v: node.v,
                arr: Array.isArray(node.arr) ? [...node.arr] : undefined,
                a: node.a,
                d: node.d,
                y: node.y,
                c: node.c,
                curve: node.curve || 'linear',
              }))
              .sort((a, b) => a.t - b.t);
            if (!nodes.length) return null;
            return {
              sourceTrackId: sourceTrack.id,
              kind: sourceTrack.kind,
              nodes,
            };
          })
          .filter(Boolean)
          .sort((a, b) => {
            const aIndex = project.tracks.findIndex((track) => track.id === a.sourceTrackId);
            const bIndex = project.tracks.findIndex((track) => track.id === b.sourceTrackId);
            return aIndex - bIndex;
          });
        if (!selectedNodeTracks.length) return;
        const allTimes = selectedNodeTracks.flatMap((item) => item.nodes.map((node) => Number(node.t) || 0));
        const baseTime = allTimes.length ? Math.min(...allTimes) : 0;
        clipboardRef.current = {
          type: 'nodes',
          tracks: selectedNodeTracks,
          baseTime,
        };

        const nodeIdMap = new Map(
          selectedNodeTracks.map((entry) => [
            entry.sourceTrackId,
            new Set(entry.nodes.map((node) => node.id).filter(Boolean)),
          ])
        );
        let changed = false;
        const nextTracks = project.tracks.map((track) => {
          const ids = nodeIdMap.get(track.id);
          if (!ids || !Array.isArray(track.nodes) || !track.nodes.length) return track;
          const nextNodes = track.nodes.filter((node) => !ids.has(node.id));
          if (nextNodes.length === track.nodes.length) return track;
          changed = true;
          return {
            ...track,
            nodes: nextNodes,
          };
        });
        if (changed) {
          dispatch({
            type: 'update-project',
            patch: {
              tracks: nextTracks,
            },
          });
        }
        selectedNodeIdsByTrackRef.current.clear();
        syncSelectedNodeSnapshot();
        return;
      }
      if (withCommand && key === 'v') {
        const payload = clipboardRef.current;
        if (!payload) return;
        event.preventDefault();
        if (payload.type === 'tracks') {
          const clipTracks = Array.isArray(payload.tracks) ? payload.tracks : [];
          if (!clipTracks.length) return;
          const selectedSet = new Set(selectedTrackIds);
          let insertAfterId = selectedTrackId || null;
          if (selectedSet.size) {
            const selectedIndexes = project.tracks
              .map((track, index) => (selectedSet.has(track.id) ? index : -1))
              .filter((index) => index >= 0);
            if (selectedIndexes.length) {
              const lastIndex = Math.max(...selectedIndexes);
              insertAfterId = project.tracks[lastIndex]?.id || insertAfterId;
            }
          }
          dispatch({
            type: 'paste-tracks',
            insertAfterId,
            tracks: clipTracks.map((track) => JSON.parse(JSON.stringify(track))),
          });
          return;
        }
        if (payload.type === 'nodes') {
          const copiedTracks = Array.isArray(payload.tracks) ? payload.tracks.filter(Boolean) : [];
          if (copiedTracks.length) {
            const validTracks = copiedTracks.filter((entry) => (
              entry
              && typeof entry.sourceTrackId === 'string'
              && entry.sourceTrackId
              && typeof entry.kind === 'string'
              && entry.kind
              && Array.isArray(entry.nodes)
              && entry.nodes.length
            ));
            if (!validTracks.length) return;
            const copiedTimes = validTracks.flatMap((entry) => entry.nodes.map((node) => Number(node.t) || 0));
            const baseTime = Number.isFinite(Number(payload.baseTime))
              ? Number(payload.baseTime)
              : (copiedTimes.length ? Math.min(...copiedTimes) : 0);

            if (validTracks.length > 1) {
              validTracks.forEach((entry) => {
                const targetTrack = project.tracks.find((track) => (
                  track.id === entry.sourceTrackId
                  && track.kind === entry.kind
                  && track.kind !== 'audio'
                  && track.kind !== 'group'
                ));
                if (!targetTrack) return;
                const nodes = entry.nodes.map((node) => ({
                  t: clamp(playhead + ((Number(node.t) || 0) - baseTime), 0, project.view.length),
                  v: Number(node.v) || 0,
                  arr: Array.isArray(node.arr) ? [...node.arr] : undefined,
                  a: node.a,
                  d: node.d,
                  y: node.y,
                  c: node.c,
                  curve: node.curve || 'linear',
                }));
                if (!nodes.length) return;
                dispatch({ type: 'add-nodes', id: targetTrack.id, nodes });
              });
              return;
            }

            const copiedTrack = validTracks[0];
            const selectedTrack = project.tracks.find((track) => track.id === selectedTrackId);
            const sourceTrack = project.tracks.find((track) => (
              track.id === copiedTrack.sourceTrackId
              && track.kind === copiedTrack.kind
            ));
            let targetTrack = null;
            if (
              selectedTrack
              && selectedTrack.kind === copiedTrack.kind
              && selectedTrack.kind !== 'audio'
              && selectedTrack.kind !== 'group'
            ) {
              targetTrack = selectedTrack;
            } else if (sourceTrack && sourceTrack.kind !== 'audio' && sourceTrack.kind !== 'group') {
              targetTrack = sourceTrack;
            }
            if (!targetTrack) return;
            const nodes = copiedTrack.nodes.map((node) => ({
              t: clamp(playhead + ((Number(node.t) || 0) - baseTime), 0, project.view.length),
              v: Number(node.v) || 0,
              arr: Array.isArray(node.arr) ? [...node.arr] : undefined,
              a: node.a,
              d: node.d,
              y: node.y,
              c: node.c,
              curve: node.curve || 'linear',
            }));
            dispatch({ type: 'add-nodes', id: targetTrack.id, nodes });
            if (selectedTrackId !== targetTrack.id) {
              dispatch({ type: 'select-track', id: targetTrack.id });
            }
            return;
          }

          // Backward compatibility for old clipboard payload shape.
          const copiedNodes = Array.isArray(payload.nodes) ? payload.nodes : [];
          if (!copiedNodes.length) return;
          const selectedTrack = project.tracks.find((track) => track.id === selectedTrackId);
          const sourceTrack = project.tracks.find((track) => track.id === payload.sourceTrackId);
          let targetTrack = null;
          if (
            selectedTrack
            && sourceTrack
            && selectedTrack.kind === sourceTrack.kind
            && selectedTrack.kind !== 'audio'
            && selectedTrack.kind !== 'group'
          ) {
            targetTrack = selectedTrack;
          } else if (sourceTrack && sourceTrack.kind !== 'audio' && sourceTrack.kind !== 'group') {
            targetTrack = sourceTrack;
          }
          if (!targetTrack) return;
          const baseTime = Math.min(...copiedNodes.map((node) => Number(node.t) || 0));
          const nodes = copiedNodes.map((node) => ({
            t: clamp(playhead + ((Number(node.t) || 0) - baseTime), 0, project.view.length),
            v: Number(node.v) || 0,
            arr: Array.isArray(node.arr) ? [...node.arr] : undefined,
            a: node.a,
            d: node.d,
            y: node.y,
            c: node.c,
            curve: node.curve || 'linear',
          }));
          dispatch({ type: 'add-nodes', id: targetTrack.id, nodes });
          if (selectedTrackId !== targetTrack.id) {
            dispatch({ type: 'select-track', id: targetTrack.id });
          }
          return;
        }
      }
      if (withCommand && key === 'z') {
        event.preventDefault();
        dispatch({ type: event.shiftKey ? 'redo' : 'undo' });
        return;
      }
      if (withCommand && key === 'y') {
        event.preventDefault();
        dispatch({ type: 'redo' });
        return;
      }
      if (withCommand && key === 'o') {
        event.preventDefault();
        dispatch({ type: 'add-track', kind: 'osc' });
        return;
      }
      if (withCommand && key === 'a') {
        event.preventDefault();
        dispatch({ type: 'add-track', kind: 'audio' });
        return;
      }
      if (withCommand && key === 'm') {
        event.preventDefault();
        if (event.shiftKey) {
          dispatch({ type: 'add-track', kind: 'midi-note' });
        } else {
          dispatch({ type: 'add-track', kind: 'midi' });
        }
        return;
      }
      if (withCommand && key === 'd') {
        event.preventDefault();
        if (event.shiftKey) {
          dispatch({ type: 'add-track', kind: 'dmx-color' });
        } else {
          dispatch({ type: 'add-track', kind: 'dmx' });
        }
        return;
      }
      if (withCommand && (event.code === 'Equal' || event.code === 'Minus')) {
        event.preventDefault();
        dispatch({
          type: 'zoom-time',
          direction: event.code === 'Equal' ? 1 : -1,
          center: playhead,
        });
        return;
      }
      if (event.repeat) return;
      if (event.code === 'Space' || event.key === ' ') {
        event.preventDefault();
        handlePlayToggle();
        return;
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        event.preventDefault();
        const selectedNodeEntries = Array.from(selectedNodeIdsByTrackRef.current.entries())
          .filter(([trackId, nodeIds]) => {
            if (!trackId || !Array.isArray(nodeIds) || !nodeIds.length) return false;
            const track = project.tracks.find((item) => item.id === trackId);
            return Boolean(track && track.kind !== 'audio');
          });

        if (selectedNodeEntries.length) {
          const nodeIdMap = new Map(
            selectedNodeEntries.map(([trackId, nodeIds]) => [trackId, new Set(nodeIds)])
          );
          const nextTracks = project.tracks.map((track) => {
            const ids = nodeIdMap.get(track.id);
            if (!ids || !Array.isArray(track.nodes) || !track.nodes.length) return track;
            return {
              ...track,
              nodes: track.nodes.filter((node) => !ids.has(node.id)),
            };
          });
          dispatch({
            type: 'update-project',
            patch: {
              tracks: nextTracks,
            },
          });
          selectedNodeIdsByTrackRef.current.clear();
          syncSelectedNodeSnapshot();
          return;
        }
        const targetIds = getTracksToDelete();
        if (!targetIds.length) return;
        if (targetIds.length === 1) {
          dispatch({ type: 'delete-track', id: targetIds[0] });
          return;
        }
        dispatch({ type: 'delete-tracks', ids: targetIds });
        return;
      }
      if (event.key?.toLowerCase() === 'c' && isPlaying) {
        dispatch({ type: 'add-cue', time: playhead });
        return;
      }
      if (event.code === 'Comma' || event.code === 'Period') {
        const cues = (project.cues || []).slice().sort((a, b) => a.t - b.t);
        if (!cues.length) return;
        event.preventDefault();
        const epsilon = 1e-4;
        const direction = event.code === 'Period' ? 1 : -1;
        let targetCue = null;
        if (direction > 0) {
          targetCue = cues.find((cue) => cue.t > playhead + epsilon) || null;
        } else {
          targetCue = [...cues].reverse().find((cue) => cue.t < playhead - epsilon) || null;
        }
        if (!targetCue) return;
        lastTickRef.current = null;
        setPlayhead(targetCue.t);
        syncAudioToPlayhead(targetCue.t);
        return;
      }
      if (event.code === 'Equal') {
        event.preventDefault();
        dispatch({ type: 'add-cue', time: clamp(playhead, 0, project.view.length) });
        return;
      }
      if (event.code === 'Minus') {
        event.preventDefault();
        const cues = project.cues || [];
        if (!cues.length) return;
        const fps = Math.max(Number(syncFpsPreset.fps) || 30, 1);
        const tolerance = 0.5 / fps;
        let targetCue = null;
        let targetDiff = Number.POSITIVE_INFINITY;
        cues.forEach((cue) => {
          const diff = Math.abs(cue.t - playhead);
          if (diff < targetDiff) {
            targetCue = cue;
            targetDiff = diff;
          }
        });
        if (!targetCue || targetDiff > tolerance) return;
        dispatch({ type: 'delete-cue', id: targetCue.id });
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [
    isHelpOpen,
    multiAddDialog,
    audioChannelMapTrackId,
    editingAudioClip,
    isPlaying,
    playhead,
    selectedTrackId,
    selectedTrackIds,
    selectedNodeContext,
    handlePlayToggle,
    project.cues,
    project.tracks,
    project.audio?.outputDeviceId,
    project.view.length,
    syncFpsPreset.fps,
    audioChannelMapDraft,
    syncSelectedNodeSnapshot,
  ]);

  useEffect(() => {
    if (playhead > project.view.length) {
      setPlayhead(project.view.length);
    }
  }, [playhead, project.view.length]);

  useEffect(() => {
    if (isPlaying) return;
    oscFlagPlaybackRef.current.lastTime = clamp(Number(playheadRef.current) || 0, 0, project.view.length);
  }, [isPlaying, project.view.length, playhead]);

  useEffect(() => {
    let changed = false;
    setAudioWaveforms((prev) => {
      const next = { ...prev };
      project.tracks.forEach((track) => {
        if (track.kind !== 'audio') return;
        if (!track.audio?.src) {
          if (next[track.id]) {
            delete next[track.id];
            changed = true;
          }
          return;
        }
        const trackPeaks = Array.isArray(track.audio?.waveformPeaks) ? track.audio.waveformPeaks : null;
        const trackDuration =
          (Number.isFinite(track.audio?.waveformDuration) && track.audio.waveformDuration > 0
            ? track.audio.waveformDuration
            : (Number.isFinite(track.audio?.duration) && track.audio.duration > 0
              ? track.audio.duration
              : project.view.length)) || 1;
        if (!next[track.id] || !Array.isArray(next[track.id].peaks) || next[track.id].peaks.length < 2) {
          next[track.id] = {
            peaks:
              trackPeaks && trackPeaks.length >= 2
                ? trackPeaks
                : createSilentPeaks(getWaveformSampleCount(trackDuration)),
            duration: trackDuration,
          };
          changed = true;
        } else if (trackPeaks && trackPeaks.length >= 2 && next[track.id].peaks !== trackPeaks) {
          next[track.id] = { peaks: trackPeaks, duration: trackDuration };
          changed = true;
        }
      });
      if (!changed) return prev;
      return next;
    });
  }, [project.tracks, project.view.length, project.audio?.sampleRate, project.audio?.bufferSize]);

  const handlePatchTrack = (patch) => {
    if (!selectedTrack) return;
    dispatch({ type: 'update-track', id: selectedTrack.id, patch });
  };

  const openAudioChannelMapDialog = (trackId) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track || track.kind !== 'audio') return;
    const outputDeviceId =
      typeof track.audio?.outputDeviceId === 'string' && track.audio.outputDeviceId
        ? track.audio.outputDeviceId
        : 'project-default';
    const sourceChannels = clamp(Math.round(Number(track.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS);
    const resolvedOutputDeviceId =
      outputDeviceId === 'project-default'
        ? (project.audio?.outputDeviceId || 'default')
        : outputDeviceId;
    const outputChannelCount = getDetectedOutputChannels(resolvedOutputDeviceId);
    const raw = Array.isArray(track.audio?.channelMap) ? track.audio.channelMap : [];
    const channelMap = Array.from({ length: sourceChannels }, (_, index) => {
      const fallback = ((index % outputChannelCount) + 1);
      const value = Math.round(Number(raw[index]) || fallback);
      return clamp(value, 1, outputChannelCount);
    });
    setAudioChannelMapDraft({
      outputDeviceId,
      channelMap,
    });
    setAudioChannelMapTrackId(trackId);
  };

  const closeAudioChannelMapDialog = () => {
    setAudioChannelMapTrackId(null);
    setAudioChannelMapDraft(null);
  };

  const patchAudioChannelMapTrack = (trackId, audioPatch) => {
    if (!trackId) return;
    dispatch({
      type: 'update-track',
      id: trackId,
      patch: {
        audio: audioPatch,
      },
    });
  };

  const setAudioMapRoute = (rowIndex, outputChannel) => {
    setAudioChannelMapDraft((prev) => {
      if (!prev) return prev;
      const nextMap = Array.from({ length: audioMapSourceChannels }, (_, index) => {
        const fallback = ((index % audioMapOutputChannelCount) + 1);
        const value = Math.round(Number(prev.channelMap?.[index]) || fallback);
        return clamp(value, 1, audioMapOutputChannelCount);
      });
      nextMap[rowIndex] = clamp(outputChannel, 1, audioMapOutputChannelCount);
      return {
        ...prev,
        channelMap: nextMap,
      };
    });
  };

  const confirmAudioChannelMap = () => {
    if (!audioChannelMapTrack) return;
    const outputDeviceId =
      typeof audioMapSelectedOutputDeviceId === 'string' && audioMapSelectedOutputDeviceId
        ? audioMapSelectedOutputDeviceId
        : 'project-default';
    patchAudioChannelMapTrack(audioChannelMapTrack.id, {
      outputDeviceId,
      channelMapEnabled: true,
      channels: audioMapSourceChannels,
      channelMap: audioMapChannelMap,
    });
    closeAudioChannelMapDialog();
  };

  const toggleTrackMute = (trackId) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track) return;
    dispatch({ type: 'update-track', id: trackId, patch: { mute: !track.mute } });
  };

  const toggleTrackSolo = (trackId) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track) return;
    dispatch({ type: 'update-track', id: trackId, patch: { solo: !track.solo } });
  };

  const clearAllTrackSolo = () => {
    if (!hasAnyTrackSolo) return;
    dispatch({
      type: 'update-project',
      patch: {
        tracks: project.tracks.map((track) => (
          track.solo ? { ...track, solo: false } : track
        )),
      },
    });
  };

  const clearAllTrackMute = () => {
    if (!hasAnyTrackMute) return;
    dispatch({
      type: 'update-project',
      patch: {
        tracks: project.tracks.map((track) => (
          track.mute ? { ...track, mute: false } : track
        )),
      },
    });
  };

  const toggleGroupExpanded = (trackId) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track || track.kind !== 'group') return;
    const expanded = track.group?.expanded !== false;
    dispatch({
      type: 'update-track',
      id: trackId,
      patch: {
        group: {
          expanded: !expanded,
        },
      },
    });
  };

  const getTracksToDelete = useCallback(() => {
    const existing = new Set(project.tracks.map((track) => track.id));
    const ids = selectedTrackIds.filter((id) => existing.has(id));
    if (ids.length) return expandTrackIdsWithGroupMembers(ids);
    if (selectedTrackId && existing.has(selectedTrackId)) {
      return expandTrackIdsWithGroupMembers([selectedTrackId]);
    }
    return [];
  }, [expandTrackIdsWithGroupMembers, project.tracks, selectedTrackIds, selectedTrackId]);

  const handleDeleteTrack = () => {
    const ids = getTracksToDelete();
    if (!ids.length) return;
    if (ids.length === 1) {
      dispatch({ type: 'delete-track', id: ids[0] });
      return;
    }
    dispatch({ type: 'delete-tracks', ids });
  };

  const handleDeleteNodes = useCallback((trackId, nodeIds) => {
    const ids = Array.from(new Set((Array.isArray(nodeIds) ? nodeIds : []).filter(Boolean)));
    if (!trackId || !ids.length) return;
    const idSet = new Set(ids);
    let changed = false;
    const nextTracks = project.tracks.map((track) => {
      if (track.id !== trackId || track.kind === 'audio' || !Array.isArray(track.nodes)) return track;
      const nextNodes = track.nodes.filter((node) => !idSet.has(node.id));
      if (nextNodes.length === track.nodes.length) return track;
      changed = true;
      return {
        ...track,
        nodes: nextNodes,
      };
    });
    if (!changed) return;
    dispatch({
      type: 'update-project',
      patch: {
        tracks: nextTracks,
      },
    });
    const selectedMap = selectedNodeIdsByTrackRef.current;
    const selectedIds = selectedMap.get(trackId);
    if (Array.isArray(selectedIds) && selectedIds.length) {
      const remaining = selectedIds.filter((id) => !idSet.has(id));
      if (remaining.length) {
        selectedMap.set(trackId, remaining);
      } else {
        selectedMap.delete(trackId);
      }
      syncSelectedNodeSnapshot();
    }
  }, [dispatch, project.tracks, syncSelectedNodeSnapshot]);

  const handleSetNodeCurve = useCallback((trackId, nodeIds, curveMode) => {
    const ids = Array.from(new Set((Array.isArray(nodeIds) ? nodeIds : []).filter(Boolean)));
    if (!trackId || !ids.length) return;
    const curve = normalizeCurveMode(curveMode);
    const idSet = new Set(ids);
    let changed = false;
    const nextTracks = project.tracks.map((track) => {
      if (track.id !== trackId || track.kind === 'audio' || track.kind === 'group' || !Array.isArray(track.nodes)) {
        return track;
      }
      const nextNodes = track.nodes.map((node) => {
        if (!idSet.has(node.id)) return node;
        if ((node.curve || 'linear') === curve) return node;
        changed = true;
        return { ...node, curve };
      });
      if (!changed) return track;
      return {
        ...track,
        nodes: nextNodes,
      };
    });
    if (!changed) return;
    dispatch({
      type: 'update-project',
      patch: {
        tracks: nextTracks,
      },
    });
  }, [dispatch, project.tracks]);

  const handleMoveTrack = (sourceId, targetId, position = 'before') => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    const targetTrack = project.tracks.find((track) => track.id === targetId);
    if (!targetTrack) return;
    const targetGroupId = targetTrack.kind === 'group'
      ? ''
      : (groupHostByTrackId.get(targetTrack.id) || '');
    const sourceSet = new Set([sourceId]);
    const moving = project.tracks.filter((track) => sourceSet.has(track.id));
    if (!moving.length) return;
    const remaining = project.tracks.filter((track) => !sourceSet.has(track.id));
    const targetIndex = remaining.findIndex((track) => track.id === targetId);
    if (targetIndex < 0) return;
    const insertAt = position === 'after' ? targetIndex + 1 : targetIndex;
    const nextTracks = [...remaining];
    nextTracks.splice(
      clamp(insertAt, 0, nextTracks.length),
      0,
      ...moving.map((track) => {
        if (track.kind === 'group') {
          return track.groupId ? { ...track, groupId: '' } : track;
        }
        const nextGroupId = typeof targetGroupId === 'string' ? targetGroupId : '';
        return track.groupId === nextGroupId ? track : { ...track, groupId: nextGroupId };
      })
    );
    dispatch({
      type: 'update-project',
      patch: { tracks: nextTracks },
    });
  };

  const handleMoveTrackGroup = (sourceIds, targetId, position = 'after') => {
    const ids = Array.isArray(sourceIds) ? sourceIds.filter(Boolean) : [];
    if (!ids.length || !targetId) return;
    const sourceSet = new Set(ids);
    const moving = project.tracks.filter((track) => sourceSet.has(track.id));
    if (!moving.length) return;
    const remaining = project.tracks.filter((track) => !sourceSet.has(track.id));
    const targetIndex = remaining.findIndex((track) => track.id === targetId);
    if (targetIndex < 0) return;
    const targetTrack = remaining[targetIndex];
    const targetGroupId = targetTrack?.kind === 'group'
      ? ''
      : (groupHostByTrackId.get(targetTrack?.id) || '');
    const containsGroup = moving.some((track) => track.kind === 'group');
    const patchedMoving = moving.map((track) => {
      if (track.kind === 'group') {
        return track.groupId ? { ...track, groupId: '' } : track;
      }
      if (containsGroup) return track;
      const nextGroupId = typeof targetGroupId === 'string' ? targetGroupId : '';
      return track.groupId === nextGroupId ? track : { ...track, groupId: nextGroupId };
    });
    const insertAt = position === 'before' ? targetIndex : targetIndex + 1;
    const nextTracks = [...remaining];
    nextTracks.splice(clamp(insertAt, 0, nextTracks.length), 0, ...patchedMoving);
    dispatch({
      type: 'update-project',
      patch: { tracks: nextTracks },
    });
  };

  const handleMoveTracksAtGroupBoundary = (sourceIds, groupId, position = 'after') => {
    const ids = Array.isArray(sourceIds) ? sourceIds.filter(Boolean) : [];
    if (!ids.length || !groupId) return;
    const groupTrack = project.tracks.find((track) => track.id === groupId && track.kind === 'group');
    if (!groupTrack) return;
    const sourceSet = new Set(ids);
    const moving = project.tracks.filter((track) => sourceSet.has(track.id));
    if (!moving.length) return;
    const remaining = project.tracks.filter((track) => !sourceSet.has(track.id));
    let insertAt = 0;
    if (position === 'before') {
      insertAt = remaining.findIndex((track) => track.id === groupId);
      if (insertAt < 0) return;
    } else {
      const groupMembers = remaining.filter((track) => track.kind !== 'group' && track.groupId === groupId);
      if (groupMembers.length) {
        const anchorId = groupMembers[groupMembers.length - 1].id;
        const anchorIndex = remaining.findIndex((track) => track.id === anchorId);
        if (anchorIndex < 0) return;
        insertAt = anchorIndex + 1;
      } else {
        const groupIndex = remaining.findIndex((track) => track.id === groupId);
        if (groupIndex < 0) return;
        insertAt = groupIndex + 1;
      }
    }
    const patchedMoving = moving.map((track) => {
      if (track.kind === 'group') return track.groupId ? { ...track, groupId: '' } : track;
      return track.groupId ? { ...track, groupId: '' } : track;
    });
    const nextTracks = [...remaining];
    nextTracks.splice(clamp(insertAt, 0, nextTracks.length), 0, ...patchedMoving);
    dispatch({
      type: 'update-project',
      patch: {
        tracks: nextTracks,
      },
    });
  };

  const handleMoveTracksIntoGroup = (sourceIds, groupId) => {
    const group = project.tracks.find((track) => track.id === groupId && track.kind === 'group');
    if (!group) return;

    const expandedSourceIds = expandTrackIdsWithGroupMembers(sourceIds);
    if (!expandedSourceIds.length) return;
    if (expandedSourceIds.includes(groupId)) return;
    const sourceTracks = expandedSourceIds
      .map((id) => project.tracks.find((track) => track.id === id))
      .filter(Boolean);
    if (sourceTracks.some((track) => track.kind === 'group')) return;
    const sourceSet = new Set(sourceTracks.map((track) => track.id));
    if (!sourceSet.size) return;
    const moving = project.tracks.filter((track) => sourceSet.has(track.id));
    if (!moving.length) return;
    const remaining = project.tracks.filter((track) => !sourceSet.has(track.id));
    const groupMembers = remaining.filter((track) => track.kind !== 'group' && track.groupId === groupId);
    let insertAt = 0;
    if (groupMembers.length) {
      const anchorId = groupMembers[groupMembers.length - 1].id;
      const anchorIndex = remaining.findIndex((track) => track.id === anchorId);
      if (anchorIndex < 0) return;
      insertAt = anchorIndex + 1;
    } else {
      const groupIndex = remaining.findIndex((track) => track.id === groupId);
      if (groupIndex < 0) return;
      insertAt = groupIndex + 1;
    }
    const patchedMoving = moving.map((track) => (
      track.groupId === groupId ? track : { ...track, groupId }
    ));
    const nextTracks = [...remaining];
    nextTracks.splice(clamp(insertAt, 0, nextTracks.length), 0, ...patchedMoving);
    dispatch({
      type: 'update-project',
      patch: {
        tracks: nextTracks,
      },
    });
  };

  const handleTrackRowSelect = (trackId, event = null) => {
    if (!trackId) return;
    const shiftPressed = Boolean(event?.shiftKey);
    const ctrlPressed = Boolean(event?.ctrlKey || event?.metaKey);
    const trackIdsInOrder = visibleTrackIdsInOrder;
    const clickedIndex = trackIdsInOrder.indexOf(trackId);
    if (clickedIndex < 0) return;

    const baseSelection = selectedTrackIds.length
      ? selectedTrackIds.filter((id) => trackIdsInOrder.includes(id))
      : (selectedTrackId ? [selectedTrackId] : []);

    if (shiftPressed) {
      const fallbackAnchorId =
        selectionAnchorTrackIdRef.current && trackIdsInOrder.includes(selectionAnchorTrackIdRef.current)
          ? selectionAnchorTrackIdRef.current
          : (selectedTrackId && trackIdsInOrder.includes(selectedTrackId) ? selectedTrackId : trackId);
      const anchorIndex = trackIdsInOrder.indexOf(fallbackAnchorId);
      const start = Math.min(anchorIndex, clickedIndex);
      const end = Math.max(anchorIndex, clickedIndex);
      const rangeIds = trackIdsInOrder.slice(start, end + 1);
      const nextSelection = ctrlPressed
        ? Array.from(new Set([...baseSelection, ...rangeIds]))
        : rangeIds;
      dispatch({ type: 'select-track', id: trackId });
      setSelectedTrackIds(nextSelection);
      return;
    }

    if (ctrlPressed) {
      let nextSelection = baseSelection;
      if (baseSelection.includes(trackId)) {
        if (baseSelection.length > 1) {
          nextSelection = baseSelection.filter((id) => id !== trackId);
        }
      } else {
        nextSelection = [...baseSelection, trackId];
      }
      const focusId = nextSelection.includes(trackId)
        ? trackId
        : nextSelection[nextSelection.length - 1] || trackId;
      dispatch({ type: 'select-track', id: focusId });
      setSelectedTrackIds(nextSelection);
      selectionAnchorTrackIdRef.current = focusId;
      return;
    }

    dispatch({ type: 'select-track', id: trackId });
    selectionAnchorTrackIdRef.current = trackId;
    if (selectedTrackIds.length === 1 && selectedTrackIds[0] === trackId) return;
    if (selectedTrackId === trackId && selectedTrackIds.length === 0) {
      setSelectedTrackIds([trackId]);
      return;
    }
    setSelectedTrackIds([trackId]);
  };

  const beginTrackInlineRename = (track) => {
    if (!track?.id) return;
    handleTrackRowSelect(track.id);
    setEditingTrackNameId(track.id);
    setEditingTrackName(typeof track.name === 'string' ? track.name : '');
  };

  const cancelTrackInlineRename = () => {
    setEditingTrackNameId(null);
    setEditingTrackName('');
  };

  const commitTrackInlineRename = (trackId = editingTrackNameId) => {
    if (!trackId) return;
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track) {
      cancelTrackInlineRename();
      return;
    }
    const trimmed = (editingTrackName || '').trim();
    if (!trimmed || trimmed === track.name) {
      cancelTrackInlineRename();
      return;
    }
    dispatch({
      type: 'update-track',
      id: trackId,
      patch: { name: trimmed },
    });
    cancelTrackInlineRename();
  };

  const getGroupedChildSummary = (track) => {
    if (!track) return '';
    if (track.kind === 'audio') {
      const clip = track.audio?.name || 'No audio';
      return `Audio · ${clip}`;
    }
    if (track.kind === 'osc') {
      return `OSC ${Number(track.min ?? 0).toFixed(2)}~${Number(track.max ?? 1).toFixed(2)} · ${track.oscAddress || '/'}`;
    }
    if (track.kind === 'osc-array') {
      const count = clamp(Math.round(Number(track.oscArray?.valueCount) || 5), 1, 20);
      return `OSC Array ${count}ch · ${track.oscAddress || '/'}`;
    }
    if (track.kind === 'osc-3d') {
      const bounds = normalizeOsc3dBounds(track);
      return `3D OSC X[${bounds.xMin.toFixed(2)}, ${bounds.xMax.toFixed(2)}] · Y[${bounds.yMin.toFixed(2)}, ${bounds.yMax.toFixed(2)}] · Z[${bounds.zMin.toFixed(2)}, ${bounds.zMax.toFixed(2)}]`;
    }
    if (track.kind === 'osc-flag') {
      return `OSC Flag · ${(Array.isArray(track.nodes) ? track.nodes.length : 0)} flags · ${track.oscAddress || '/'}`;
    }
    if (track.kind === 'osc-color') {
      return `OSC Color ${(track.oscColor?.fixtureType === 'rgbw' ? 'RGBW' : 'RGB')} · ${track.oscAddress || '/'}`;
    }
    if (track.kind === 'midi') {
      const channel = Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1)));
      const cc = Math.max(0, Math.min(127, Math.round(Number(track.midi?.controlNumber) || 1)));
      return `MIDI CC Ch ${channel} · CC ${cc}`;
    }
    if (track.kind === 'midi-note') {
      const channel = Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1)));
      return `MIDI Note Ch ${channel}`;
    }
    if (track.kind === 'dmx') {
      const universe = Math.max(0, Math.min(32767, Math.round(Number(track.dmx?.universe) || 0)));
      const channel = Math.max(1, Math.min(512, Math.round(Number(track.dmx?.channel) || 1)));
      return `DMX U${universe} Ch${channel}`;
    }
    if (track.kind === 'dmx-color') {
      const universe = Math.max(0, Math.min(32767, Math.round(Number(track.dmxColor?.universe) || 0)));
      const channelStart = Math.max(1, Math.min(512, Math.round(Number(track.dmxColor?.channelStart) || 1)));
      return `DMX Color U${universe} Ch${channelStart}`;
    }
    return '';
  };

  const handleTrackColorChange = (trackId, color) => {
    const safe = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#5dd8c7';
    const targets =
      selectedTrackIds.includes(trackId) && selectedTrackIds.length > 1
        ? selectedTrackIds
        : [trackId];
    dispatch({
      type: 'update-tracks-color',
      ids: targets,
      color: safe,
    });
  };

  const handleNameEnterNext = () => {
    if (!selectedTrackId) return;
    const index = visibleTracks.findIndex((track) => track.id === selectedTrackId);
    if (index < 0) return;
    const nextTrack = visibleTracks[index + 1];
    if (!nextTrack) return;
    dispatch({ type: 'select-track', id: nextTrack.id });
    setNameFocusToken((prev) => prev + 1);
  };

  const handleAddNode = (trackId, node) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (track?.kind === 'audio' || track?.kind === 'group') return;
    if (track?.kind === 'midi-note') {
      const safeNode = {
        ...node,
        t: clamp(Number(node?.t) || playhead, 0, project.view.length),
        v: clamp(Math.round(Number(node?.v) || 60), 0, 127),
        d: Math.max(Number(node?.d) || 0.5, 0.01),
        curve: 'linear',
      };
      dispatch({
        type: 'add-node',
        id: trackId,
        node: safeNode,
      });
      return;
    }
    if (track?.kind === 'midi') {
      const safeTime = clamp(Number(node?.t) || playhead, 0, project.view.length);
      const sampled = sampleTrackValue(track, safeTime);
      dispatch({
        type: 'add-node',
        id: trackId,
        node: {
          ...node,
          t: safeTime,
          v: toMidiCcValue(node?.v, sampled),
          curve: 'linear',
        },
      });
      return;
    }
    if (track?.kind === 'dmx' || track?.kind === 'dmx-color') {
      const safeTime = clamp(Number(node?.t) || playhead, 0, project.view.length);
      const sampled = sampleTrackValue(track, safeTime);
      dispatch({
        type: 'add-node',
        id: trackId,
        node: {
          ...node,
          t: safeTime,
          v: toDmxValue(node?.v, sampled),
          curve: 'linear',
        },
      });
      return;
    }
    if (track?.kind === 'osc-flag') {
      const fallbackAddress = normalizeOscAddressPath(track.oscAddress, '/osc/flag');
      const safeNode = {
        ...node,
        t: clamp(Number(node?.t) || playhead, 0, project.view.length),
        v: Number.isFinite(Number(node?.v)) ? Number(node.v) : 1,
        d: Math.max(Number(node?.d) || 1, 0),
        y: Number.isFinite(Number(node?.y)) ? clamp(Number(node.y), 0, 1) : 0.5,
        a: normalizeOscAddressPath(node?.a, fallbackAddress),
      };
      dispatch({
        type: 'add-node',
        id: trackId,
        node: safeNode,
      });
      return;
    }
    if (track?.kind === 'osc-array') {
      const safeTime = clamp(Number(node?.t) || playhead, 0, project.view.length);
      const sampledValues = sampleOscArrayTrackValues(track, safeTime, project.timebase?.fps);
      const raw = Array.isArray(node?.arr) ? node.arr : sampledValues;
      const min = Number.isFinite(track.min) ? track.min : 0;
      const max = Number.isFinite(track.max) ? track.max : 1;
      const count = getOscArrayValueCount(track);
      const values = Array.from({ length: count }, (_, index) => (
        clamp(Number(raw[index] ?? sampledValues[index] ?? track.default ?? 0) || 0, min, max)
      ));
      dispatch({
        type: 'add-node',
        id: trackId,
        node: {
          ...node,
          t: safeTime,
          v: values[0] ?? 0,
          arr: values,
        },
      });
      return;
    }
    if (track?.kind === 'osc-3d') {
      const safeTime = clamp(Number(node?.t) || playhead, 0, project.view.length);
      const sampledValues = sampleOsc3dTrackValues(track, safeTime, project.timebase?.fps);
      const raw = Array.isArray(node?.arr) ? node.arr : sampledValues;
      const bounds = normalizeOsc3dBounds(track);
      const x = clamp(Number(raw[0] ?? sampledValues[0]) || 0, bounds.xMin, bounds.xMax);
      const y = clamp(Number(raw[1] ?? sampledValues[1]) || 0, bounds.yMin, bounds.yMax);
      const z = clamp(Number(raw[2] ?? sampledValues[2]) || 0, bounds.zMin, bounds.zMax);
      dispatch({
        type: 'add-node',
        id: trackId,
        node: {
          ...node,
          t: safeTime,
          v: y,
          arr: [x, y, z],
        },
      });
      return;
    }
    dispatch({
      type: 'add-node',
      id: trackId,
      node,
    });
  };

  const handleNodeDrag = (trackId, nodeId, patch) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (track?.kind === 'audio') return;
    const nextPatch = { ...patch };
    if (track?.kind === 'midi' && Object.prototype.hasOwnProperty.call(nextPatch, 'v')) {
      nextPatch.v = toMidiCcValue(nextPatch.v, track.default);
    }
    if ((track?.kind === 'dmx' || track?.kind === 'dmx-color')
      && Object.prototype.hasOwnProperty.call(nextPatch, 'v')) {
      nextPatch.v = toDmxValue(nextPatch.v, track.default);
    }
    if (!track) return;

    const sourceNode = Array.isArray(track.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
    const hasTimePatch = Object.prototype.hasOwnProperty.call(nextPatch, 't')
      && Number.isFinite(Number(nextPatch.t))
      && Number.isFinite(Number(sourceNode?.t));
    const selectedByTrack = selectedNodeIdsByTrackRef.current;
    const sourceSelection = Array.isArray(selectedByTrack.get(trackId))
      ? selectedByTrack.get(trackId)
      : [];
    const shouldCrossTrackShift = hasTimePatch && sourceSelection.includes(nodeId);

    if (!shouldCrossTrackShift) {
      dispatch({ type: 'update-node', id: trackId, nodeId, patch: nextPatch });
      return;
    }

    const deltaT = Number(nextPatch.t) - Number(sourceNode.t);
    if (!Number.isFinite(deltaT) || Math.abs(deltaT) < 1e-9) {
      dispatch({ type: 'update-node', id: trackId, nodeId, patch: nextPatch });
      return;
    }

    const patchesByTrack = new Map();
    const pushPatch = (targetTrackId, targetNodeId, targetPatch) => {
      if (!patchesByTrack.has(targetTrackId)) patchesByTrack.set(targetTrackId, new Map());
      patchesByTrack.get(targetTrackId).set(targetNodeId, targetPatch);
    };

    pushPatch(trackId, nodeId, nextPatch);

    selectedByTrack.forEach((ids, targetTrackId) => {
      if (!Array.isArray(ids) || !ids.length) return;
      const targetTrack = project.tracks.find((item) => item.id === targetTrackId);
      if (!targetTrack || targetTrack.kind === 'audio') return;
      ids.forEach((selectedId) => {
        if (targetTrackId === trackId && selectedId === nodeId) return;
        const targetNode = Array.isArray(targetTrack.nodes)
          ? targetTrack.nodes.find((item) => item.id === selectedId)
          : null;
        if (!targetNode) return;
        pushPatch(targetTrackId, selectedId, {
          t: clamp((Number(targetNode.t) || 0) + deltaT, 0, project.view.length),
        });
      });
    });

    if (patchesByTrack.size === 1 && patchesByTrack.get(trackId)?.size === 1) {
      dispatch({ type: 'update-node', id: trackId, nodeId, patch: nextPatch });
      return;
    }

    const nextTracks = project.tracks.map((item) => {
      const trackPatches = patchesByTrack.get(item.id);
      if (!trackPatches?.size) return item;
      const nextNodes = (Array.isArray(item.nodes) ? item.nodes : []).map((node) => {
        const patchForNode = trackPatches.get(node.id);
        if (!patchForNode) return node;
        return { ...node, ...patchForNode };
      });
      return { ...item, nodes: nextNodes };
    });

    dispatch({
      type: 'update-project',
      patch: {
        tracks: nextTracks,
      },
    });
  };

  const handlePatchSingleNode = (trackId, nodeId, patch) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (!track || track.kind === 'audio') return;
    const nextPatch = { ...patch };
    if (Object.prototype.hasOwnProperty.call(nextPatch, 't')) {
      nextPatch.t = clamp(Number(nextPatch.t) || 0, 0, project.view.length);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'd')) {
      nextPatch.d = Math.max(Number(nextPatch.d) || 1, 0);
    }
    if (Object.prototype.hasOwnProperty.call(nextPatch, 'y')) {
      nextPatch.y = Number.isFinite(Number(nextPatch.y)) ? clamp(Number(nextPatch.y), 0, 1) : 0.5;
    }
    if (track.kind === 'midi' && Object.prototype.hasOwnProperty.call(nextPatch, 'v')) {
      nextPatch.v = toMidiCcValue(nextPatch.v, track.default);
    }
    if ((track.kind === 'dmx' || track.kind === 'dmx-color')
      && Object.prototype.hasOwnProperty.call(nextPatch, 'v')) {
      nextPatch.v = toDmxValue(nextPatch.v, track.default);
    }
    if (track.kind === 'osc-flag' && Object.prototype.hasOwnProperty.call(nextPatch, 'a')) {
      nextPatch.a = normalizeOscAddressPath(nextPatch.a, normalizeOscAddressPath(track.oscAddress, '/osc/flag'));
    }
    if (track.kind === 'osc-flag' && Object.prototype.hasOwnProperty.call(nextPatch, 'v')) {
      nextPatch.v = formatOscOutputScalar(nextPatch.v, getOscSendValueType(track));
    }
    dispatch({ type: 'update-node', id: trackId, nodeId, patch: nextPatch });
  };

  const handleNodeSelectionChange = useCallback((trackId, nodeIds) => {
    const nextIds = Array.isArray(nodeIds) ? nodeIds : [];
    const map = selectedNodeIdsByTrackRef.current;
    if (!trackId) return;
    if (nextIds.length) {
      map.set(trackId, nextIds);
    } else {
      map.delete(trackId);
    }
    syncSelectedNodeSnapshot(trackId);
  }, [syncSelectedNodeSnapshot]);

  const handleTrackLanesMarqueeStart = useCallback((event) => {
    if (event.button !== 0) return;
    const target = event.target;
    if (target?.closest?.('[data-selectable-node="1"]')) return;
    if (target?.closest?.('.audio-lane__clip-hit')) return;

    const panel = trackLanesPanelRef.current;
    if (!panel) return;
    const panelRect = panel.getBoundingClientRect();
    if (!panelRect.width || !panelRect.height) return;

    event.preventDefault();
    event.stopPropagation();

    trackEditMarqueeRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      moved: false,
    };

    const toLocal = (clientX, clientY) => ({
      x: clamp(clientX - panelRect.left, 0, panelRect.width),
      y: clamp(clientY - panelRect.top, 0, panelRect.height),
    });

    const startLocal = toLocal(event.clientX, event.clientY);
    setTrackEditMarquee({
      x1: startLocal.x,
      y1: startLocal.y,
      x2: startLocal.x,
      y2: startLocal.y,
    });

    const applySelection = (clientX, clientY) => {
      const marquee = trackEditMarqueeRef.current;
      if (!marquee) return;
      const left = Math.min(marquee.startClientX, clientX);
      const right = Math.max(marquee.startClientX, clientX);
      const top = Math.min(marquee.startClientY, clientY);
      const bottom = Math.max(marquee.startClientY, clientY);
      const nodeElements = panel.querySelectorAll('[data-selectable-node="1"][data-track-id][data-node-id]');
      const nextMap = new Map();

      nodeElements.forEach((element) => {
        const trackId = element.getAttribute('data-track-id');
        const nodeId = element.getAttribute('data-node-id');
        if (!trackId || !nodeId) return;
        const rect = element.getBoundingClientRect();
        const cx = (rect.left + rect.right) * 0.5;
        const cy = (rect.top + rect.bottom) * 0.5;
        if (cx < left || cx > right || cy < top || cy > bottom) return;
        if (!nextMap.has(trackId)) nextMap.set(trackId, []);
        const ids = nextMap.get(trackId);
        if (!ids.includes(nodeId)) ids.push(nodeId);
      });

      selectedNodeIdsByTrackRef.current = nextMap;
      syncSelectedNodeSnapshot();
    };

    const onPointerMove = (moveEvent) => {
      const marquee = trackEditMarqueeRef.current;
      if (!marquee) return;
      const dx = Math.abs(moveEvent.clientX - marquee.startClientX);
      const dy = Math.abs(moveEvent.clientY - marquee.startClientY);
      if (!marquee.moved && (dx > 2 || dy > 2)) {
        marquee.moved = true;
      }
      const local = toLocal(moveEvent.clientX, moveEvent.clientY);
      setTrackEditMarquee({
        x1: startLocal.x,
        y1: startLocal.y,
        x2: local.x,
        y2: local.y,
      });
      applySelection(moveEvent.clientX, moveEvent.clientY);
    };

    const onPointerEnd = () => {
      const marquee = trackEditMarqueeRef.current;
      trackEditMarqueeRef.current = null;
      setTrackEditMarquee(null);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
      if (!marquee?.moved) {
        selectedNodeIdsByTrackRef.current = new Map();
        syncSelectedNodeSnapshot();
      }
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  }, [syncSelectedNodeSnapshot]);

  const handleEditNode = (trackId, nodeId, value, mode = 'value', colorHex = null) => {
    const track = project.tracks.find((item) => item.id === trackId);
    if (track?.kind === 'audio') return;
    if (mode === 'midi-note' && track?.kind === 'midi-note') {
      const node = Array.isArray(track.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
      if (!node) return;
      const parts = secondsToHmsfParts(
        clamp(Number(node.t) || 0, 0, project.view.length),
        syncFpsPreset.fps
      );
      setEditingNode({
        trackId,
        nodeId,
        mode: 'midi-note',
        noteHours: String(parts.hours),
        noteMinutes: String(parts.minutes),
        noteSeconds: String(parts.seconds),
        noteFrames: String(parts.frames),
        noteValue: String(clamp(Math.round(Number(node.v) || 60), 0, 127)),
        noteLength: Number.isFinite(Number(node.d)) ? Number(node.d).toFixed(2) : '0.50',
      });
      return;
    }
    if (track?.kind === 'osc-flag') {
      const node = Array.isArray(track.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
      if (!node) return;
      const valueType = getOscSendValueType(track);
      const safeValue = formatOscOutputScalar(node.v, valueType);
      const parts = secondsToHmsfParts(
        clamp(Number(node.t) || 0, 0, project.view.length),
        syncFpsPreset.fps
      );
      setEditingNode({
        trackId,
        nodeId,
        mode: 'osc-flag',
        flagHours: String(parts.hours),
        flagMinutes: String(parts.minutes),
        flagSeconds: String(parts.seconds),
        flagFrames: String(parts.frames),
        triggerTime: Number.isFinite(Number(node.d)) ? Number(node.d).toFixed(2) : '1.00',
        address: normalizeOscAddressPath(
          node.a,
          normalizeOscAddressPath(track.oscAddress, '/osc/flag')
        ),
        valueType,
        value: valueType === 'int'
          ? String(Math.round(Number(safeValue) || 1))
          : (Number.isFinite(Number(safeValue)) ? Number(safeValue).toFixed(2) : '1.00'),
      });
      return;
    }
    if (mode === 'osc-array' && track?.kind === 'osc-array') {
      const node = Array.isArray(track.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
      if (!node) return;
      const valueType = getOscSendValueType(track);
      const parts = secondsToHmsfParts(
        clamp(Number(node.t) || 0, 0, project.view.length),
        syncFpsPreset.fps
      );
      const values = normalizeOscArrayNodeValues(track, node).map((item) => (
        valueType === 'int'
          ? String(Math.round(Number(item) || 0))
          : Number(item).toFixed(2)
      ));
      setEditingNode({
        trackId,
        nodeId,
        mode: 'osc-array',
        valueType,
        arrayHours: String(parts.hours),
        arrayMinutes: String(parts.minutes),
        arraySeconds: String(parts.seconds),
        arrayFrames: String(parts.frames),
        arrayValues: values,
      });
      return;
    }
    if (mode === 'osc-3d' && track?.kind === 'osc-3d') {
      const node = Array.isArray(track.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
      if (!node) return;
      const bounds = normalizeOsc3dBounds(track);
      const values = normalizeOsc3dNodeValues(track, node);
      const valueType = getOscSendValueType(track);
      const parts = secondsToHmsfParts(
        clamp(Number(node.t) || 0, 0, project.view.length),
        syncFpsPreset.fps
      );
      const toText = (numeric) => (
        valueType === 'int'
          ? String(Math.round(Number(numeric) || 0))
          : Number(numeric).toFixed(2)
      );
      setEditingNode({
        trackId,
        nodeId,
        mode: 'osc-3d',
        valueType,
        osc3dHours: String(parts.hours),
        osc3dMinutes: String(parts.minutes),
        osc3dSeconds: String(parts.seconds),
        osc3dFrames: String(parts.frames),
        xValue: toText(values[0]),
        yValue: toText(values[1]),
        zValue: toText(values[2]),
      });
      return;
    }
    const numeric = Number(value);
    if (mode === 'color' && (track?.kind === 'dmx-color' || track?.kind === 'osc-color')) {
      const node = Array.isArray(track.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
      const fallbackColor = typeof node?.c === 'string' && HEX_COLOR_RE.test(node.c)
        ? node.c
        : colorTrackValueToHex(track, Number.isFinite(numeric) ? numeric : track.default);
      const color = typeof colorHex === 'string' && HEX_COLOR_RE.test(colorHex) ? colorHex : fallbackColor;
      const parts = secondsToHmsfParts(
        clamp(Number(node?.t) || 0, 0, project.view.length),
        syncFpsPreset.fps
      );
      setEditingNode({
        trackId,
        nodeId,
        mode: 'color',
        color: color.toLowerCase(),
        colorHours: String(parts.hours),
        colorMinutes: String(parts.minutes),
        colorSeconds: String(parts.seconds),
        colorFrames: String(parts.frames),
      });
      return;
    }
    const node = Array.isArray(track?.nodes) ? track.nodes.find((item) => item.id === nodeId) : null;
    const parts = secondsToHmsfParts(
      clamp(Number(node?.t) || 0, 0, project.view.length),
      syncFpsPreset.fps
    );
    setEditingNode({
      trackId,
      nodeId,
      mode: 'value',
      valueType: track?.kind === 'osc' ? getOscSendValueType(track) : null,
      valueHours: String(parts.hours),
      valueMinutes: String(parts.minutes),
      valueSeconds: String(parts.seconds),
      valueFrames: String(parts.frames),
      value: track?.kind === 'midi'
        ? String(toMidiCcValue(numeric, track.default ?? 0))
        : track?.kind === 'dmx' || track?.kind === 'dmx-color'
          ? String(toDmxValue(numeric, track.default ?? 0))
        : track?.kind === 'osc' && getOscSendValueType(track) === 'int'
          ? String(Math.round(Number.isFinite(numeric) ? numeric : (track?.default ?? 0)))
        : (Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00'),
    });
  };

  const handleEditCue = (cue) => {
    const parts = secondsToHmsfParts(cue.t, syncFpsPreset.fps);
    setEditingCue({
      id: cue.id,
      hours: parts.hours,
      minutes: parts.minutes,
      seconds: parts.seconds,
      frames: parts.frames,
    });
  };

  const handleCueAdd = (time) => {
    dispatch({ type: 'add-cue', time });
  };

  const handleCueStep = (direction) => {
    const cues = (project.cues || []).slice().sort((a, b) => a.t - b.t);
    if (!cues.length) return;
    const epsilon = 1e-4;
    if (direction > 0) {
      const nextCue = cues.find((cue) => cue.t > playhead + epsilon);
      if (nextCue) {
        handleSeek(nextCue.t);
      }
      return;
    }
    const previousCue = [...cues].reverse().find((cue) => cue.t < playhead - epsilon);
    if (previousCue) {
      handleSeek(previousCue.t);
    }
  };

  const handleCueAddAtPlayhead = () => {
    dispatch({ type: 'add-cue', time: clamp(playhead, 0, project.view.length) });
  };

  const handleCueDeleteAtPlayhead = () => {
    const cues = project.cues || [];
    if (!cues.length) return;
    const fps = Math.max(Number(syncFpsPreset.fps) || 30, 1);
    const tolerance = 0.5 / fps;
    let targetCue = null;
    let targetDiff = Number.POSITIVE_INFINITY;
    cues.forEach((cue) => {
      const diff = Math.abs(cue.t - playhead);
      if (diff < targetDiff) {
        targetCue = cue;
        targetDiff = diff;
      }
    });
    if (!targetCue || targetDiff > tolerance) return;
    dispatch({ type: 'delete-cue', id: targetCue.id });
  };

  const handleCueMove = (id, time) => {
    dispatch({ type: 'update-cue', id, time });
  };

  const handleCueDelete = (id) => {
    dispatch({ type: 'delete-cue', id });
  };

  const handleSyncChange = (nextMode) => {
    const mode = nextMode === 'MTC' || nextMode === 'LTC' ? nextMode : 'Internal';
    dispatch({
      type: 'update-project',
      patch: { timebase: { sync: mode } },
    });
    mtcStateRef.current = createMtcState();
    mtcPllRef.current = createMtcPllState();
    if (mode !== 'MTC' && mtcFollowTimeoutRef.current) {
      window.clearTimeout(mtcFollowTimeoutRef.current);
      mtcFollowTimeoutRef.current = null;
    }
    if (mode !== 'LTC') {
      stopLtcSync();
    }
    if (mode !== 'Internal') {
      setIsPlaying(false);
      lastTickRef.current = null;
      stopInternalClock();
    }
  };

  const handleSyncFpsChange = (syncFpsId) => {
    const preset = resolveSyncFps(syncFpsId);
    dispatch({
      type: 'update-project',
      patch: { timebase: { syncFps: preset.id } },
    });
    mtcStateRef.current = createMtcState();
    mtcPllRef.current = createMtcPllState();
  };

  const handleStop = () => {
    setIsPlaying(false);
    stopInternalClock();
    pauseNativeAudioEngine();
  };

  async function handlePlayToggle() {
    if (isPlaying) {
      setIsPlaying(false);
      stopInternalClock();
      return;
    }
    if (useNativeAudioEngine) {
      await configureNativeAudioEngine().catch(() => {});
      playNativeAudioEngine(playhead);
    }
    resumeAudioEngines();
    project.tracks.forEach((track) => {
      if (track.kind !== 'audio' || !track.audio?.src) return;
      if (!isTrackEnabled(track, 'audio')) return;
      if (useNativeAudioEngine) return;
      const audio = getAudioElement(track);
      if (!audio) return;
      if (track.audio?.channelMapEnabled) {
        const routing = ensureMappedAudioRouting(track, audio);
        if (routing?.context?.state === 'suspended' && typeof routing.context.resume === 'function') {
          routing.context.resume().catch(() => {});
        }
      }
      const timing = getAudioTrackTiming(track, audio, playhead);
      if (!timing.inRange) {
        if (timing.localTime < 0) {
          seekAudioElement(track, audio, 0);
        } else {
          seekAudioElement(track, audio, Math.max(timing.duration - 0.001, 0));
        }
        audio.pause();
        return;
      }
      seekAudioElement(track, audio, timing.localTime);
      const result = audio.play();
      if (result && typeof result.catch === 'function') {
        result.catch(() => {});
      }
    });
    if (project.timebase?.sync === 'Internal') {
      startInternalClock(playhead);
    }
    setIsPlaying(true);
  }

  const handleRecordToggle = () => {
    setIsRecording((prev) => !prev);
  };

  const handleLoopToggle = () => {
    const length = Math.max(Number(project.view.length) || 0, 0);
    const minSpan = 1 / Math.max(syncFpsPreset.fps, 1);
    let loopStart = clamp(Number(project.view.loopStart) || 0, 0, length);
    let loopEnd = clamp(Number(project.view.loopEnd) || Math.min(project.view.end, length), 0, length);
    if (loopEnd - loopStart < minSpan) {
      loopEnd = clamp(loopStart + minSpan, 0, length);
      if (loopEnd - loopStart < minSpan) {
        loopStart = clamp(loopEnd - minSpan, 0, length);
      }
    }
    dispatch({
      type: 'update-project',
      patch: {
        view: {
          loopEnabled: !project.view.loopEnabled,
          loopStart,
          loopEnd,
        },
      },
    });
  };

  const handleLocate = () => {
    setIsPlaying(false);
    stopInternalClock();
    pauseNativeAudioEngine();
    dispatch({ type: 'scroll-time', start: 0 });
    setPlayhead(0);
    syncAudioToPlayhead(0);
  };

  const handleSeek = (time) => {
    lastTickRef.current = null;
    const nextTime = clamp(Number(time) || 0, 0, project.view.length);
    const span = Math.max(project.view.end - project.view.start, 0.001);
    if (nextTime < project.view.start || nextTime > project.view.end) {
      const targetStart = clamp(
        nextTime - span * 0.25,
        0,
        Math.max(project.view.length - span, 0)
      );
      dispatch({ type: 'scroll-time', start: targetStart });
    }
    if (isPlaying && (project.timebase?.sync || 'Internal') === 'Internal') {
      startInternalClock(nextTime);
    }
    setPlayhead(nextTime);
    syncAudioToPlayhead(nextTime);
  };

  const handleScroll = (start) => {
    dispatch({ type: 'scroll-time', start });
  };

  const handleTimecodeCommit = (text) => {
    const parsed = parseHmsfTimecode(text, syncFpsPreset.fps);
    if (!Number.isFinite(parsed)) return false;
    const next = clamp(parsed, 0, project.view.length);
    handleSeek(next);
    return true;
  };

  const handleLoopRangeChange = ({ start, end }) => {
    const length = Math.max(Number(project.view.length) || 0, 0);
    const minSpan = 1 / Math.max(syncFpsPreset.fps, 1);
    let loopStart = clamp(Number(start) || 0, 0, length);
    let loopEnd = clamp(Number(end) || 0, 0, length);
    if (loopEnd - loopStart < minSpan) {
      if (loopStart <= Number(project.view.loopStart || 0)) {
        loopStart = clamp(loopEnd - minSpan, 0, length);
      } else {
        loopEnd = clamp(loopStart + minSpan, 0, length);
      }
    }
    dispatch({
      type: 'update-project',
      patch: {
        view: {
          loopStart,
          loopEnd,
        },
      },
    });
  };

  const handleOpenLoopRangeEditor = () => {
    const startParts = secondsToHmsfParts(Number(project.view.loopStart) || 0, syncFpsPreset.fps);
    const endParts = secondsToHmsfParts(Number(project.view.loopEnd) || 0, syncFpsPreset.fps);
    setEditingLoopRange({
      startHours: String(startParts.hours),
      startMinutes: String(startParts.minutes),
      startSeconds: String(startParts.seconds),
      startFrames: String(startParts.frames),
      endHours: String(endParts.hours),
      endMinutes: String(endParts.minutes),
      endSeconds: String(endParts.seconds),
      endFrames: String(endParts.frames),
    });
  };

  const handleSaveLoopRange = () => {
    if (!editingLoopRange) return;
    const length = Math.max(Number(project.view.length) || 0, 0);
    const minSpan = 1 / Math.max(syncFpsPreset.fps, 1);
    let start = clamp(
      hmsfPartsToSeconds(
        Number(editingLoopRange.startHours) || 0,
        Number(editingLoopRange.startMinutes) || 0,
        Number(editingLoopRange.startSeconds) || 0,
        Number(editingLoopRange.startFrames) || 0,
        syncFpsPreset.fps
      ),
      0,
      length
    );
    let end = clamp(
      hmsfPartsToSeconds(
        Number(editingLoopRange.endHours) || 0,
        Number(editingLoopRange.endMinutes) || 0,
        Number(editingLoopRange.endSeconds) || 0,
        Number(editingLoopRange.endFrames) || 0,
        syncFpsPreset.fps
      ),
      0,
      length
    );
    if (end - start < minSpan) {
      end = clamp(start + minSpan, 0, length);
      if (end - start < minSpan) {
        start = clamp(end - minSpan, 0, length);
      }
    }
    dispatch({
      type: 'update-project',
      patch: {
        view: {
          loopStart: start,
          loopEnd: end,
        },
      },
    });
    setEditingLoopRange(null);
  };

  const handleAudioClipMove = (trackId, clipStart) => {
    if (!trackId) return;
    dispatch({
      type: 'update-track',
      id: trackId,
      patch: {
        audio: {
          clipStart: clamp(Number(clipStart) || 0, 0, project.view.length),
        },
      },
    });
  };

  const handleEditAudioClipStart = (trackId, clipStart) => {
    const safeStart = clamp(Number(clipStart) || 0, 0, project.view.length);
    const parts = secondsToHmsfParts(safeStart, syncFpsPreset.fps);
    setEditingAudioClip({
      trackId,
      hours: String(parts.hours),
      minutes: String(parts.minutes),
      seconds: String(parts.seconds),
      frames: String(parts.frames),
    });
  };

  const handleSaveNodeValue = () => {
    if (!editingNode) return;
    if (editingNode.mode === 'midi-note') {
      const nodeTime = clamp(
        hmsfPartsToSeconds(
          Number(editingNode.noteHours) || 0,
          Number(editingNode.noteMinutes) || 0,
          Number(editingNode.noteSeconds) || 0,
          Number(editingNode.noteFrames) || 0,
          syncFpsPreset.fps
        ),
        0,
        project.view.length
      );
      const noteValue = clamp(Math.round(Number(editingNode.noteValue) || 60), 0, 127);
      const noteLength = Math.max(Number(editingNode.noteLength) || 0.5, 0.01);
      dispatch({
        type: 'update-node',
        id: editingNode.trackId,
        nodeId: editingNode.nodeId,
        patch: {
          t: nodeTime,
          v: noteValue,
          d: noteLength,
        },
      });
      setEditingNode(null);
      return;
    }
    if (editingNode.mode === 'osc-flag') {
      const track = project.tracks.find((item) => item.id === editingNode.trackId);
      const nodeTime = clamp(
        hmsfPartsToSeconds(
          Number(editingNode.flagHours) || 0,
          Number(editingNode.flagMinutes) || 0,
          Number(editingNode.flagSeconds) || 0,
          Number(editingNode.flagFrames) || 0,
          syncFpsPreset.fps
        ),
        0,
        project.view.length
      );
      const triggerTime = Math.max(Number(editingNode.triggerTime) || 1, 0);
      const valueType = editingNode.valueType === 'int' ? 'int' : 'float';
      const value = formatOscOutputScalar(editingNode.value, valueType);
      const fallbackAddress = normalizeOscAddressPath(track?.oscAddress, '/osc/flag');
      const address = normalizeOscAddressPath(editingNode.address, fallbackAddress);
      dispatch({
        type: 'update-track',
        id: editingNode.trackId,
        patch: {
          oscValueType: valueType,
        },
      });
      dispatch({
        type: 'update-node',
        id: editingNode.trackId,
        nodeId: editingNode.nodeId,
        patch: {
          t: nodeTime,
          d: triggerTime,
          v: Number.isFinite(Number(value)) ? Number(value) : 1,
          a: address,
        },
      });
      setEditingNode(null);
      return;
    }
    if (editingNode.mode === 'osc-array') {
      const track = project.tracks.find((item) => item.id === editingNode.trackId);
      if (!track || track.kind !== 'osc-array') {
        setEditingNode(null);
        return;
      }
      const nodeTime = clamp(
        hmsfPartsToSeconds(
          Number(editingNode.arrayHours) || 0,
          Number(editingNode.arrayMinutes) || 0,
          Number(editingNode.arraySeconds) || 0,
          Number(editingNode.arrayFrames) || 0,
          syncFpsPreset.fps
        ),
        0,
        project.view.length
      );
      const min = Number.isFinite(track.min) ? track.min : 0;
      const max = Number.isFinite(track.max) ? track.max : 1;
      const count = getOscArrayValueCount(track);
      const valueType = editingNode.valueType === 'int' ? 'int' : getOscSendValueType(track);
      const raw = Array.isArray(editingNode.arrayValues) ? editingNode.arrayValues : [];
      const nextValues = Array.from({ length: count }, (_, index) => (
        clamp(
          Number(formatOscOutputScalar(raw[index] ?? track.default ?? 0, valueType)) || 0,
          min,
          max
        )
      ));
      dispatch({
        type: 'update-node',
        id: editingNode.trackId,
        nodeId: editingNode.nodeId,
        patch: {
          t: nodeTime,
          v: nextValues[0] ?? track.default ?? 0,
          arr: nextValues,
        },
      });
      setEditingNode(null);
      return;
    }
    if (editingNode.mode === 'osc-3d') {
      const track = project.tracks.find((item) => item.id === editingNode.trackId);
      if (!track || track.kind !== 'osc-3d') {
        setEditingNode(null);
        return;
      }
      const nodeTime = clamp(
        hmsfPartsToSeconds(
          Number(editingNode.osc3dHours) || 0,
          Number(editingNode.osc3dMinutes) || 0,
          Number(editingNode.osc3dSeconds) || 0,
          Number(editingNode.osc3dFrames) || 0,
          syncFpsPreset.fps
        ),
        0,
        project.view.length
      );
      const valueType = editingNode.valueType === 'int' ? 'int' : 'float';
      const bounds = normalizeOsc3dBounds(track);
      const formatAxisValue = (raw, axisMin, axisMax, fallback) => {
        const parsed = Number(raw);
        const numeric = Number.isFinite(parsed) ? parsed : fallback;
        const converted = valueType === 'int' ? Math.round(numeric) : Math.round(numeric * 100) / 100;
        return clamp(converted, axisMin, axisMax);
      };
      const fallbackValues = normalizeOsc3dNodeValues(track, {
        arr: [editingNode.xValue, editingNode.yValue, editingNode.zValue],
        v: editingNode.yValue,
      });
      const x = formatAxisValue(editingNode.xValue, bounds.xMin, bounds.xMax, fallbackValues[0]);
      const y = formatAxisValue(editingNode.yValue, bounds.yMin, bounds.yMax, fallbackValues[1]);
      const z = formatAxisValue(editingNode.zValue, bounds.zMin, bounds.zMax, fallbackValues[2]);

      dispatch({
        type: 'update-track',
        id: editingNode.trackId,
        patch: {
          oscValueType: valueType,
        },
      });
      dispatch({
        type: 'update-node',
        id: editingNode.trackId,
        nodeId: editingNode.nodeId,
        patch: {
          t: nodeTime,
          arr: [x, y, z],
          v: y,
        },
      });
      setEditingNode(null);
      return;
    }
    if (editingNode.mode === 'color') {
      const track = project.tracks.find((item) => item.id === editingNode.trackId);
      const safeColor = typeof editingNode.color === 'string' && HEX_COLOR_RE.test(editingNode.color)
        ? editingNode.color
        : '#000000';
      const nodeTime = clamp(
        hmsfPartsToSeconds(
          Number(editingNode.colorHours) || 0,
          Number(editingNode.colorMinutes) || 0,
          Number(editingNode.colorSeconds) || 0,
          Number(editingNode.colorFrames) || 0,
          syncFpsPreset.fps
        ),
        0,
        project.view.length
      );
      const value = colorTrackHexToValue(track, safeColor);
      if (Number.isFinite(value)) {
        const rounded = Math.round(value * 100) / 100;
        dispatch({
          type: 'update-node',
          id: editingNode.trackId,
          nodeId: editingNode.nodeId,
          patch: { t: nodeTime, v: rounded, c: safeColor.toLowerCase() },
        });
      }
      setEditingNode(null);
      return;
    }
    const track = project.tracks.find((item) => item.id === editingNode.trackId);
    const value = Number(editingNode.value);
    if (Number.isFinite(value)) {
      const nodeTime = clamp(
        hmsfPartsToSeconds(
          Number(editingNode.valueHours) || 0,
          Number(editingNode.valueMinutes) || 0,
          Number(editingNode.valueSeconds) || 0,
          Number(editingNode.valueFrames) || 0,
          syncFpsPreset.fps
        ),
        0,
        project.view.length
      );
      const rounded = track?.kind === 'midi'
        ? toMidiCcValue(value, track.default ?? 0)
        : track?.kind === 'dmx' || track?.kind === 'dmx-color'
          ? toDmxValue(value, track.default ?? 0)
        : track?.kind === 'osc' && getOscSendValueType(track) === 'int'
          ? Math.round(value)
        : Math.round(value * 100) / 100;
      dispatch({
        type: 'update-node',
        id: editingNode.trackId,
        nodeId: editingNode.nodeId,
        patch: { t: nodeTime, v: rounded },
      });
    }
    setEditingNode(null);
  };

  const handleSaveCueTime = () => {
    if (!editingCue) return;
    const time = hmsfPartsToSeconds(
      editingCue.hours,
      editingCue.minutes,
      editingCue.seconds,
      editingCue.frames,
      syncFpsPreset.fps
    );
    dispatch({ type: 'update-cue', id: editingCue.id, time });
    setEditingCue(null);
  };

  const handleSaveAudioClipStart = () => {
    if (!editingAudioClip) return;
    const time = hmsfPartsToSeconds(
      Number(editingAudioClip.hours) || 0,
      Number(editingAudioClip.minutes) || 0,
      Number(editingAudioClip.seconds) || 0,
      Number(editingAudioClip.frames) || 0,
      syncFpsPreset.fps
    );
    handleAudioClipMove(editingAudioClip.trackId, time);
    setEditingAudioClip(null);
  };

  const getOsc3dEditingState = (draft) => {
    const bounds = editingNodeTrack?.kind === 'osc-3d'
      ? normalizeOsc3dBounds(editingNodeTrack)
      : normalizeOsc3dBounds({
        bounds: {
          xMin: draft?.xMin,
          xMax: draft?.xMax,
          yMin: draft?.yMin,
          yMax: draft?.yMax,
          zMin: draft?.zMin,
          zMax: draft?.zMax,
        },
      });
    const valueType = draft?.valueType === 'int' ? 'int' : 'float';
    const parseValue = (raw, fallback) => {
      const numeric = Number(raw);
      const safe = Number.isFinite(numeric) ? numeric : fallback;
      return valueType === 'int' ? Math.round(safe) : Math.round(safe * 100) / 100;
    };
    const xMid = (bounds.xMin + bounds.xMax) * 0.5;
    const yMid = (bounds.yMin + bounds.yMax) * 0.5;
    const zMid = (bounds.zMin + bounds.zMax) * 0.5;
    const x = clamp(parseValue(draft?.xValue, xMid), bounds.xMin, bounds.xMax);
    const y = clamp(parseValue(draft?.yValue, yMid), bounds.yMin, bounds.yMax);
    const z = clamp(parseValue(draft?.zValue, zMid), bounds.zMin, bounds.zMax);
    const ratio = (value, min, max) => {
      const span = Math.max(max - min, 1e-9);
      return clamp((value - min) / span, 0, 1);
    };
    return {
      bounds,
      valueType,
      values: { x, y, z },
      ratios: {
        x: ratio(x, bounds.xMin, bounds.xMax),
        y: ratio(y, bounds.yMin, bounds.yMax),
        z: ratio(z, bounds.zMin, bounds.zMax),
      },
    };
  };

  const applyOsc3dPlaneFromPointer = (plane, clientX, clientY, rect) => {
    const ratioX = clamp((clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
    const ratioY = clamp((clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
    setEditingNode((prev) => {
      if (!prev || prev.mode !== 'osc-3d') return prev;
      const osc3d = getOsc3dEditingState(prev);
      const nextValues = { ...osc3d.values };
      if (plane === 'xy') {
        nextValues.x = osc3d.bounds.xMin + ratioX * (osc3d.bounds.xMax - osc3d.bounds.xMin);
        nextValues.y = osc3d.bounds.yMax - ratioY * (osc3d.bounds.yMax - osc3d.bounds.yMin);
      } else if (plane === 'yz') {
        nextValues.y = osc3d.bounds.yMax - ratioY * (osc3d.bounds.yMax - osc3d.bounds.yMin);
        nextValues.z = osc3d.bounds.zMin + ratioX * (osc3d.bounds.zMax - osc3d.bounds.zMin);
      }
      const formatValue = (numeric) => (
        osc3d.valueType === 'int'
          ? String(Math.round(numeric))
          : (Math.round(numeric * 100) / 100).toFixed(2)
      );
      return {
        ...prev,
        xValue: formatValue(clamp(nextValues.x, osc3d.bounds.xMin, osc3d.bounds.xMax)),
        yValue: formatValue(clamp(nextValues.y, osc3d.bounds.yMin, osc3d.bounds.yMax)),
        zValue: formatValue(clamp(nextValues.z, osc3d.bounds.zMin, osc3d.bounds.zMax)),
      };
    });
  };

  const beginOsc3dPlaneDrag = (plane, event) => {
    if (!editingNode || editingNode.mode !== 'osc-3d') return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    applyOsc3dPlaneFromPointer(plane, event.clientX, event.clientY, rect);
    const onPointerMove = (moveEvent) => {
      applyOsc3dPlaneFromPointer(plane, moveEvent.clientX, moveEvent.clientY, rect);
    };
    const onPointerEnd = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  };

  const beginOsc3dCameraDrag = (event) => {
    if (!editingNode || editingNode.mode !== 'osc-3d') return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startY = event.clientY;
    const startCamera = { ...osc3dCamera };
    osc3dCameraDragRef.current = { startX, startY, startCamera };
    const onPointerMove = (moveEvent) => {
      const drag = osc3dCameraDragRef.current;
      if (!drag) return;
      const deltaX = moveEvent.clientX - drag.startX;
      const deltaY = moveEvent.clientY - drag.startY;
      setOsc3dCamera({
        yaw: drag.startCamera.yaw + deltaX * 0.35,
        pitch: clamp(drag.startCamera.pitch - deltaY * 0.35, -85, 85),
        zoom: drag.startCamera.zoom,
      });
    };
    const onPointerEnd = () => {
      osc3dCameraDragRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  };

  const handleOsc3dCameraWheel = (event) => {
    if (!editingNode || editingNode.mode !== 'osc-3d') return;
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setOsc3dCamera((prev) => ({
      ...prev,
      zoom: clamp((Number(prev.zoom) || 1) + direction * 0.08, 0.55, 2.4),
    }));
  };

  const handleSave = () => {
    const payload = JSON.stringify(project, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name || 'osconductor'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleLoad = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  const handleFileChange = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      audioElementsRef.current.forEach((audio) => {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      });
      audioElementsRef.current.clear();
      audioRoutingRef.current.forEach((_, trackId) => {
        releaseAudioRouting(trackId, true);
      });
      audioRoutingRef.current.clear();
      audioUrlRef.current.forEach((url) => {
        if (typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url);
        }
      });
      audioUrlRef.current.clear();
      pendingSeekRef.current.clear();
      setAudioWaveforms({});
      compositionPlayheadsRef.current = new Map();
      dispatch({ type: 'load-project', project: data });
      setIsPlaying(false);
      setIsRecording(false);
      setAudioChannelMapTrackId(null);
      setAudioChannelMapDraft(null);
      setPlayhead(data?.view?.start ?? 0);
    } catch (error) {
      window.alert('Failed to load project JSON.');
    } finally {
      event.target.value = '';
    }
  };

  const playheadX = useMemo(() => {
    const start = Number(project.view.start) || 0;
    const end = Number(project.view.end) || start + 1;
    const span = Math.max(end - start, 0.0001);
    const clamped = clamp(playhead, start, end);
    const width = Math.max(Number(timelineWidth) || TIMELINE_WIDTH, TIMELINE_PADDING * 2 + 1);
    return ((clamped - start) / span) * (width - 2 * TIMELINE_PADDING) + TIMELINE_PADDING;
  }, [playhead, project.view.start, project.view.end, timelineWidth]);

  const zoomTime = (direction) => {
    dispatch({ type: 'zoom-time', direction, center: playhead });
  };

  const zoomTrackHeight = (delta) => {
    dispatch({ type: 'zoom-track-height', delta });
  };

  useEffect(() => {
    const getWheelDelta = (event) => {
      const deltaY = Number(event.deltaY) || 0;
      const deltaX = Number(event.deltaX) || 0;
      if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY;
      return deltaX;
    };

    const handleWheelZoom = (event) => {
      if (!event.shiftKey) return;
      const target = event.target;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;
      if (
        isSettingsOpen
        || isHelpOpen
        || editingNode
        || editingCue
        || editingLoopRange
        || editingAudioClip
        || audioChannelMapTrackId
      ) return;

      const delta = getWheelDelta(event);
      if (delta === 0) return;
      const direction = delta < 0 ? 1 : -1;
      if (event.ctrlKey) {
        event.preventDefault();
        zoomTrackHeight(direction > 0 ? 12 : -12);
        return;
      }
      if (!event.altKey) return;
      event.preventDefault();
      zoomTime(direction);
    };

    window.addEventListener('wheel', handleWheelZoom, { passive: false });
    return () => {
      window.removeEventListener('wheel', handleWheelZoom);
    };
  }, [
    isSettingsOpen,
    isHelpOpen,
    editingNode,
    editingCue,
    editingLoopRange,
    editingAudioClip,
    audioChannelMapTrackId,
    playhead,
  ]);

  const currentTime = useMemo(
    () => formatHmsfTimecode(playhead, syncFpsPreset.fps),
    [playhead, syncFpsPreset.fps]
  );

  const lengthParts = useMemo(
    () => secondsToHmsfParts(project.view.length, syncFpsPreset.fps),
    [project.view.length, syncFpsPreset.fps]
  );
  const trackInfoDensity = useMemo(() => {
    const height = Number(project.view.trackHeight) || 96;
    if (height < 88) return 'compact';
    if (height < 120) return 'medium';
    return 'full';
  }, [project.view.trackHeight]);
  const audioMapSourceChannels = useMemo(
    () => clamp(Math.round(Number(audioChannelMapTrack?.audio?.channels) || 2), 1, MAX_AUDIO_CHANNELS),
    [audioChannelMapTrack]
  );
  const audioMapProjectOutputId = project.audio?.outputDeviceId || 'default';
  const audioMapProjectOutputLabel = useMemo(() => {
    if (audioMapProjectOutputId === 'default') return 'System Default';
    if (typeof audioMapProjectOutputId === 'string' && audioMapProjectOutputId.startsWith('native:')) {
      const nativeDeviceId = Number(audioMapProjectOutputId.slice('native:'.length));
      return nativeAudioDevices.find((device) => device.id === nativeDeviceId)?.name || audioMapProjectOutputId;
    }
    return audioOutputs.find((device) => device.deviceId === audioMapProjectOutputId)?.label || audioMapProjectOutputId;
  }, [audioMapProjectOutputId, audioOutputs, nativeAudioDevices]);
  const audioMapSelectedOutputDeviceId = useMemo(() => {
    if (typeof audioChannelMapDraft?.outputDeviceId === 'string' && audioChannelMapDraft.outputDeviceId) {
      return audioChannelMapDraft.outputDeviceId;
    }
    if (typeof audioChannelMapTrack?.audio?.outputDeviceId === 'string' && audioChannelMapTrack.audio.outputDeviceId) {
      return audioChannelMapTrack.audio.outputDeviceId;
    }
    return 'project-default';
  }, [audioChannelMapDraft, audioChannelMapTrack]);
  const audioMapResolvedOutputDeviceId = useMemo(() => {
    if (audioMapSelectedOutputDeviceId === 'project-default') {
      return audioMapProjectOutputId;
    }
    return audioMapSelectedOutputDeviceId;
  }, [audioMapSelectedOutputDeviceId, audioMapProjectOutputId]);
  const audioMapOutputChannelCount = useMemo(
    () => getDetectedOutputChannels(audioMapResolvedOutputDeviceId),
    [audioMapResolvedOutputDeviceId, audioOutputChannelCaps]
  );
  const audioMapChannelMap = useMemo(() => {
    const raw = Array.isArray(audioChannelMapDraft?.channelMap)
      ? audioChannelMapDraft.channelMap
      : (
        Array.isArray(audioChannelMapTrack?.audio?.channelMap)
          ? audioChannelMapTrack.audio.channelMap
          : []
      );
    return Array.from({ length: audioMapSourceChannels }, (_, index) => {
      const fallback = ((index % audioMapOutputChannelCount) + 1);
      const value = Math.round(Number(raw[index]) || fallback);
      return clamp(value, 1, audioMapOutputChannelCount);
    });
  }, [audioChannelMapDraft, audioChannelMapTrack, audioMapSourceChannels, audioMapOutputChannelCount]);
  const oscOutputs = useMemo(
    () => normalizeOscOutputsForUi(project.osc),
    [project.osc]
  );
  const defaultOscOutput = oscOutputs[0] || {
    id: DEFAULT_OSC_OUTPUT_ID,
    name: 'Main',
    host: '127.0.0.1',
    port: 9000,
  };
  const oscOutputOptions = useMemo(
    () => oscOutputs.map((output) => ({
      id: output.id,
      name: output.name,
      host: output.host,
      port: output.port,
      label: `${output.name} (${output.host}:${output.port})`,
    })),
    [oscOutputs]
  );
  const oscOutputLabelMap = useMemo(() => {
    const map = new Map();
    oscOutputs.forEach((output) => {
      map.set(output.id, `${output.name} (${output.host}:${output.port})`);
    });
    return map;
  }, [oscOutputs]);
  const updateOscOutputs = useCallback((nextOutputs) => {
    const normalized = normalizeOscOutputsForUi({ outputs: nextOutputs });
    dispatch({
      type: 'update-project',
      patch: {
        osc: {
          outputs: normalized,
          host: normalized[0]?.host || '127.0.0.1',
          port: normalized[0]?.port || 9000,
        },
      },
    });
  }, []);
  const addOscOutput = useCallback(() => {
    const last = oscOutputs[oscOutputs.length - 1] || defaultOscOutput;
    const nextIndex = oscOutputs.length + 1;
    let nextPort = clamp((Number(last.port) || 9000) + 1, 1, 65535);
    if (nextPort === DEV_SERVER_PORT) {
      nextPort = clamp(nextPort + 1, 1, 65535);
    }
    updateOscOutputs([
      ...oscOutputs,
      {
        id: `osc-out-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`,
        name: normalizeOscOutputName('', nextIndex - 1),
        host: last.host || '127.0.0.1',
        port: nextPort,
      },
    ]);
  }, [defaultOscOutput, oscOutputs, updateOscOutputs]);
  const removeOscOutput = useCallback((outputId) => {
    if (!outputId) return;
    const filtered = oscOutputs.filter((output) => output.id !== outputId);
    if (!filtered.length) return;
    updateOscOutputs(filtered);
  }, [oscOutputs, updateOscOutputs]);
  const patchOscOutput = useCallback((outputId, patch) => {
    if (!outputId) return;
    updateOscOutputs(
      oscOutputs.map((output) => (
        output.id === outputId ? { ...output, ...patch } : output
      ))
    );
  }, [oscOutputs, updateOscOutputs]);
  const oscPortConflict = useMemo(() => ({
    outputs: oscOutputs.map((output) => Number(output.port) === DEV_SERVER_PORT),
    listenPort: Number(project.osc?.listenPort) === DEV_SERVER_PORT,
    controlPort: Number(project.osc?.controlPort) === DEV_SERVER_PORT,
  }), [oscOutputs, project.osc?.listenPort, project.osc?.controlPort]);
  const hasOscPortConflict =
    oscPortConflict.outputs.some(Boolean)
    || oscPortConflict.listenPort
    || oscPortConflict.controlPort;
  const canUndo = (historyPast?.length ?? 0) > 0;
  const canRedo = (historyFuture?.length ?? 0) > 0;
  const cueList = Array.isArray(project.cues) ? project.cues : EMPTY_LIST;
  const multiAddCount = Math.floor(Number(multiAddDialog?.count));
  const canConfirmMultiAdd = Number.isFinite(multiAddCount) && multiAddCount > 0;
  useEffect(() => {
    if (!audioChannelMapTrack) return;
    probeOutputChannels(audioMapResolvedOutputDeviceId);
  }, [audioChannelMapTrack, audioMapResolvedOutputDeviceId, probeOutputChannels]);

  useEffect(() => {
    if (!useNativeAudioEngine) {
      nativeAudioConfigKeyRef.current = '';
      nativeAudioMixKeyRef.current = '';
      pauseNativeAudioEngine();
      return;
    }
    configureNativeAudioEngine().catch(() => {});
  }, [useNativeAudioEngine, configureNativeAudioEngine, pauseNativeAudioEngine]);

  useEffect(() => {
    if (!useNativeAudioEngine) {
      nativeAudioMixKeyRef.current = '';
      return;
    }
    syncNativeAudioTrackMix().catch(() => {});
  }, [useNativeAudioEngine, syncNativeAudioTrackMix]);

  useEffect(() => {
    if (!useNativeAudioEngine) return;
    if (isPlaying) {
      playNativeAudioEngine(playheadRef.current);
      return;
    }
    pauseNativeAudioEngine();
  }, [useNativeAudioEngine, isPlaying, playNativeAudioEngine, pauseNativeAudioEngine]);

  useEffect(() => {
    if (!useNativeAudioEngine || isPlaying) return;
    seekNativeAudioEngine(playhead);
  }, [useNativeAudioEngine, isPlaying, playhead, seekNativeAudioEngine]);

  const handleUndo = () => {
    dispatch({ type: 'undo' });
  };

  const handleRedo = () => {
    dispatch({ type: 'redo' });
  };

  const handleToggleCompositions = () => {
    setIsCompositionsVisible((prev) => !prev);
  };

  const handleToggleInspector = () => {
    setIsInspectorVisible((prev) => !prev);
  };

  const openSettings = () => {
    setSettingsTab('project');
    setIsSettingsOpen(true);
  };

  const handleAddComposition = () => {
    rememberActiveCompositionPlayhead();
    setIsPlaying(false);
    stopInternalClock();
    lastTickRef.current = null;
    dispatch({ type: 'add-composition' });
    setPlayhead(0);
    setSelectedNodeContext({ trackId: null, nodeIds: [] });
    setEditingCompositionId(null);
    setEditingCompositionName('');
    setDragCompositionId(null);
    setCompositionDropTarget(null);
  };

  const handleDeleteComposition = () => {
    if (!activeCompositionId) return;
    if (!Array.isArray(compositions) || compositions.length <= 1) return;
    const currentIndex = compositions.findIndex((composition) => composition.id === activeCompositionId);
    if (currentIndex < 0) return;
    const nextComposition = compositions[
      Math.min(currentIndex + 1, compositions.length - 1)
    ] || compositions[Math.max(currentIndex - 1, 0)];
    const nextPlayhead = getRememberedCompositionPlayhead(nextComposition);

    setIsPlaying(false);
    stopInternalClock();
    lastTickRef.current = null;
    dispatch({ type: 'delete-composition', id: activeCompositionId });
    setPlayhead(nextPlayhead);
    syncAudioToPlayhead(nextPlayhead);
    setSelectedNodeContext({ trackId: null, nodeIds: [] });
    setEditingCompositionId(null);
    setEditingCompositionName('');
    setDragCompositionId(null);
    setCompositionDropTarget(null);
  };

  const handleSwitchComposition = (compositionId) => {
    if (!compositionId || compositionId === activeCompositionId) return;
    const target = compositions.find((composition) => composition.id === compositionId);
    if (!target) return;
    rememberActiveCompositionPlayhead();
    setIsPlaying(false);
    stopInternalClock();
    lastTickRef.current = null;
    const nextPlayhead = getRememberedCompositionPlayhead(target);
    dispatch({ type: 'switch-composition', id: compositionId });
    setPlayhead(nextPlayhead);
    syncAudioToPlayhead(nextPlayhead);
    setSelectedNodeContext({ trackId: null, nodeIds: [] });
    setEditingCompositionId(null);
    setEditingCompositionName('');
    setDragCompositionId(null);
    setCompositionDropTarget(null);
  };

  const beginRenameComposition = (composition) => {
    if (!composition?.id) return;
    setEditingCompositionId(composition.id);
    setEditingCompositionName(composition.name || '');
  };

  const cancelRenameComposition = () => {
    setEditingCompositionId(null);
    setEditingCompositionName('');
  };

  const commitRenameComposition = () => {
    if (!editingCompositionId) return;
    const current = compositions.find((composition) => composition.id === editingCompositionId);
    if (!current) {
      cancelRenameComposition();
      return;
    }
    const trimmed = (editingCompositionName || '').trim();
    if (!trimmed || trimmed === current.name) {
      cancelRenameComposition();
      return;
    }
    dispatch({
      type: 'update-composition',
      id: editingCompositionId,
      patch: { name: trimmed },
    });
    cancelRenameComposition();
  };

  const handleMoveComposition = (sourceId, targetId, position = 'before') => {
    if (!sourceId || !targetId || sourceId === targetId) return;
    dispatch({
      type: 'move-composition',
      sourceId,
      targetId,
      position,
    });
  };

  const openMultiAddDialog = (kind, overrides = {}) => {
    setIsAddTrackMenuOpen(false);
    const safeKind = kind === 'audio'
      || kind === 'midi'
      || kind === 'midi-note'
      || kind === 'group'
      || kind === 'dmx'
      || kind === 'dmx-color'
      || kind === 'osc-array'
      || kind === 'osc-3d'
      || kind === 'osc-color'
      || kind === 'osc-flag'
      ? kind
      : 'osc';
    const selectedMidiOutputId =
      typeof project.midi?.outputId === 'string' && project.midi.outputId
        ? project.midi.outputId
        : VIRTUAL_MIDI_OUTPUT_ID;
    const baseDialog = {
      kind: safeKind,
      count: '4',
      singleAdd: false,
      midiOutputId: selectedMidiOutputId,
      midiChannel: '1',
      midiStart: '1',
      dmxHost: '127.0.0.1',
      dmxUniverse: '0',
      dmxChannel: '1',
      dmxColorFixtureType: 'rgb',
      dmxColorMappingChannels: '4',
      dmxColorInterval: '3',
      oscArrayValueCount: '5',
    };
    setMultiAddDialog({
      ...baseDialog,
      ...overrides,
      count: typeof overrides.count === 'string' ? overrides.count : baseDialog.count,
      singleAdd: Boolean(overrides.singleAdd),
    });
  };

  const handleConfirmMultiAdd = () => {
    if (!canConfirmMultiAdd || !multiAddDialog) return;
    const safeKind =
      multiAddDialog.kind === 'audio'
      || multiAddDialog.kind === 'midi'
      || multiAddDialog.kind === 'midi-note'
      || multiAddDialog.kind === 'group'
      || multiAddDialog.kind === 'dmx'
      || multiAddDialog.kind === 'dmx-color'
      || multiAddDialog.kind === 'osc-array'
      || multiAddDialog.kind === 'osc-3d'
      || multiAddDialog.kind === 'osc-color'
      || multiAddDialog.kind === 'osc-flag'
        ? multiAddDialog.kind
        : 'osc';
    const count = clamp(multiAddCount, 1, 256);

    if (safeKind === 'dmx') {
      const host = typeof multiAddDialog.dmxHost === 'string' && multiAddDialog.dmxHost.trim()
        ? multiAddDialog.dmxHost.trim()
        : '127.0.0.1';
      const universe = clamp(Math.round(Number(multiAddDialog.dmxUniverse) || 0), 0, 32767);
      const startChannel = clamp(Math.round(Number(multiAddDialog.dmxChannel) || 1), 1, 512);
      const items = Array.from({ length: count }, (_, index) => ({
        kind: 'dmx',
        options: {
          dmx: {
            host,
            universe,
            channel: clamp(startChannel + index, 1, 512),
          },
        },
      }));
      dispatch({ type: 'add-tracks', items });
      setMultiAddDialog(null);
      return;
    }

    if (safeKind === 'group') {
      const items = Array.from({ length: count }, () => ({
        kind: 'group',
      }));
      dispatch({ type: 'add-tracks', items });
      setMultiAddDialog(null);
      return;
    }

    if (safeKind === 'dmx-color') {
      const host = typeof multiAddDialog.dmxHost === 'string' && multiAddDialog.dmxHost.trim()
        ? multiAddDialog.dmxHost.trim()
        : '127.0.0.1';
      let universe = clamp(Math.round(Number(multiAddDialog.dmxUniverse) || 0), 0, 32767);
      const baseChannel = clamp(Math.round(Number(multiAddDialog.dmxChannel) || 1), 1, 512);
      let currentChannel = baseChannel;
      const fixtureType =
        multiAddDialog.dmxColorFixtureType === 'rgbw' || multiAddDialog.dmxColorFixtureType === 'mapping'
          ? multiAddDialog.dmxColorFixtureType
          : 'rgb';
      const mappingChannels = Number(multiAddDialog.dmxColorMappingChannels) === 3 ? 3 : 4;
      const fixtureChannels = fixtureType === 'rgb' ? 3 : (fixtureType === 'rgbw' ? 4 : mappingChannels);
      const intervalChannels = clamp(
        Math.round(Number(multiAddDialog.dmxColorInterval) || fixtureChannels),
        1,
        512
      );
      const items = Array.from({ length: count }, () => {
        if (currentChannel + fixtureChannels - 1 > 512) {
          universe = clamp(universe + 1, 0, 32767);
          currentChannel = baseChannel;
        }
        if (currentChannel + fixtureChannels - 1 > 512) {
          currentChannel = 1;
        }
        const item = {
          kind: 'dmx-color',
          options: {
            dmxColor: {
              host,
              universe,
              channelStart: currentChannel,
              fixtureType,
              mappingChannels,
            },
          },
        };
        currentChannel += intervalChannels;
        if (currentChannel + fixtureChannels - 1 > 512) {
          universe = clamp(universe + 1, 0, 32767);
          currentChannel = baseChannel;
        }
        return item;
      });
      dispatch({ type: 'add-tracks', items });
      setMultiAddDialog(null);
      return;
    }

    if (safeKind === 'midi') {
      const outputId =
        typeof multiAddDialog.midiOutputId === 'string' && multiAddDialog.midiOutputId
          ? multiAddDialog.midiOutputId
          : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID);
      const channel = clamp(Math.round(Number(multiAddDialog.midiChannel) || 1), 1, 16);
      const startValue = clamp(Math.round(Number(multiAddDialog.midiStart) || 0), 0, 127);
      const items = Array.from({ length: count }, (_, index) => {
        const value = clamp(startValue + index, 0, 127);
        return {
          kind: 'midi',
          options: {
            midi: { outputId, channel, controlNumber: value },
          },
        };
      });
      dispatch({ type: 'add-tracks', items });
      setMultiAddDialog(null);
      return;
    }

    if (safeKind === 'midi-note') {
      const outputId =
        typeof multiAddDialog.midiOutputId === 'string' && multiAddDialog.midiOutputId
          ? multiAddDialog.midiOutputId
          : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID);
      const channel = clamp(Math.round(Number(multiAddDialog.midiChannel) || 1), 1, 16);
      const startNote = clamp(Math.round(Number(multiAddDialog.midiStart) || 60), 0, 127);
      const items = Array.from({ length: count }, (_, index) => {
        const note = clamp(startNote + index, 0, 127);
        return {
          kind: 'midi-note',
          options: {
            midi: { outputId, channel, note },
          },
        };
      });
      dispatch({ type: 'add-tracks', items });
      setMultiAddDialog(null);
      return;
    }

    if (safeKind === 'osc-array') {
      const valueCount = clamp(Math.round(Number(multiAddDialog.oscArrayValueCount) || 5), 1, 20);
      if (multiAddDialog.singleAdd) {
        dispatch({
          type: 'add-track',
          kind: 'osc-array',
          options: { oscArray: { valueCount } },
        });
        setMultiAddDialog(null);
        return;
      }
      const items = Array.from({ length: count }, () => ({
        kind: 'osc-array',
        options: { oscArray: { valueCount } },
      }));
      dispatch({ type: 'add-tracks', items });
      setMultiAddDialog(null);
      return;
    }

    const items = Array.from({ length: count }, () => ({ kind: safeKind }));
    dispatch({ type: 'add-tracks', items });
    setMultiAddDialog(null);
  };

  return (
    <div className="app">
      <TransportBar
        projectName={project.name}
        sync={project.timebase.sync}
        syncFps={syncFpsPreset.id}
        syncFpsOptions={SYNC_FPS_OPTIONS}
        currentTime={currentTime}
        isPlaying={isPlaying}
        isRecording={isRecording}
        isLoopEnabled={Boolean(project.view.loopEnabled)}
        onPlayToggle={handlePlayToggle}
        onRecordToggle={handleRecordToggle}
        onLoopToggle={handleLoopToggle}
        onStop={handleStop}
        onStopLocate={handleLocate}
        onSave={handleSave}
        onLoad={handleLoad}
        onUndo={handleUndo}
        onRedo={handleRedo}
        canUndo={canUndo}
        canRedo={canRedo}
        onSyncChange={handleSyncChange}
        onSyncFpsChange={handleSyncFpsChange}
        isCompositionsVisible={isCompositionsVisible}
        isInspectorVisible={isInspectorVisible}
        onToggleCompositions={handleToggleCompositions}
        onToggleInspector={handleToggleInspector}
        onOpenSettings={openSettings}
        onTimecodeCommit={handleTimecodeCommit}
      />

      {isHelpOpen && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card modal__card--help">
            <div className="modal__header">
              <div className="label">Help - Shortcuts</div>
              <button className="btn btn--ghost" onClick={() => setIsHelpOpen(false)}>
                Close
              </button>
            </div>
            <div className="modal__content help-shortcuts">
              <div className="help-shortcuts__section">
                <div className="help-shortcuts__title">Keyboard</div>
                <div className="help-shortcuts__row"><kbd>Space</kbd><span>Play / Pause</span></div>
                <div className="help-shortcuts__row"><kbd>C</kbd><span>Add cue at playhead (while playing)</span></div>
                <div className="help-shortcuts__row"><kbd>,</kbd><span>Jump to previous cue</span></div>
                <div className="help-shortcuts__row"><kbd>.</kbd><span>Jump to next cue</span></div>
                <div className="help-shortcuts__row"><kbd>=</kbd><span>Add cue at playhead</span></div>
                <div className="help-shortcuts__row"><kbd>-</kbd><span>Delete nearest cue at playhead</span></div>
                <div className="help-shortcuts__row"><kbd>Backspace / Delete</kbd><span>Delete selected node(s), or selected track(s)</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + O</kbd><span>Add OSC track</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + A</kbd><span>Add Audio track</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + M</kbd><span>Add MIDI CC track</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + Shift + M</kbd><span>Add MIDI Note track</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + D</kbd><span>Add DMX track</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + Shift + D</kbd><span>Add DMX Color track</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + S</kbd><span>Save project</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + L</kbd><span>Load project</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + C</kbd><span>Copy selected track(s), or selected node(s)</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + X</kbd><span>Cut selected node(s)</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + V</kbd><span>Paste track(s), or paste node(s) at playhead</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + Z</kbd><span>Undo</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + Shift + Z</kbd><span>Redo</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + Y</kbd><span>Redo (alternative)</span></div>
                <div className="help-shortcuts__row"><kbd>Cmd/Ctrl + = / -</kbd><span>Zoom timeline in / out</span></div>
                <div className="help-shortcuts__row"><kbd>Shift + Alt/Option + Wheel</kbd><span>Zoom W</span></div>
                <div className="help-shortcuts__row"><kbd>Shift + Ctrl + Wheel</kbd><span>Zoom H</span></div>
                <div className="help-shortcuts__row"><kbd>Enter (Audio Channel Map)</kbd><span>Save map and jump to next Audio track</span></div>
                <div className="help-shortcuts__row"><kbd>↓ (Audio Channel Map)</kbd><span>Save map and jump to next Audio track</span></div>
                <div className="help-shortcuts__row"><kbd>Enter (Track Name)</kbd><span>Save and jump to next selected track name</span></div>
                <div className="help-shortcuts__row"><kbd>Enter (Timecode)</kbd><span>Jump playhead to typed hh:mm:ss.ff</span></div>
                <div className="help-shortcuts__row"><kbd>Esc (Timecode)</kbd><span>Cancel timecode edit</span></div>
                <div className="help-shortcuts__row"><kbd>Esc</kbd><span>Close active dialog / cancel current edit</span></div>
              </div>

              <div className="help-shortcuts__section">
                <div className="help-shortcuts__title">Mouse Controls</div>
                <div className="help-shortcuts__row"><kbd>Top Bar: Comps</kbd><span>Show / Hide compositions panel</span></div>
                <div className="help-shortcuts__row"><kbd>Top Bar: Inspector</kbd><span>Show / Hide inspector panel</span></div>
                <div className="help-shortcuts__row"><kbd>Top Bar: ↺</kbd><span>Toggle timeline loop mode</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click Stop (■)</kbd><span>Locate playhead to 00:00:00.00</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click Timeline</kbd><span>Add cue at clicked time</span></div>
                <div className="help-shortcuts__row"><kbd>Drag Cue</kbd><span>Move cue time</span></div>
                <div className="help-shortcuts__row"><kbd>Right Click Cue</kbd><span>Edit or delete cue</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click Composition</kbd><span>Rename composition</span></div>
                <div className="help-shortcuts__row"><kbd>Drag Composition</kbd><span>Reorder compositions</span></div>
                <div className="help-shortcuts__row"><kbd>Alt/Option + Click Track +</kbd><span>Open Multi Add menu (add multiple tracks)</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click Node</kbd><span>Edit node value / color (OSC Flag: time + address + value)</span></div>
                <div className="help-shortcuts__row"><kbd>Drag Node</kbd><span>Move node in time/value</span></div>
                <div className="help-shortcuts__row"><kbd>Alt/Option + Drag Node</kbd><span>Snap node to nearest cue</span></div>
                <div className="help-shortcuts__row"><kbd>Drag Audio Clip</kbd><span>Move clip start time on timeline</span></div>
                <div className="help-shortcuts__row"><kbd>Alt/Option + Drag Audio Clip</kbd><span>Snap clip start to nearest cue</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click Audio Clip</kbd><span>Edit clip start time</span></div>
                <div className="help-shortcuts__row"><kbd>Drag ◣ / ◢</kbd><span>Set loop start / end range</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click ◣ / ◢</kbd><span>Edit loop range with exact hh:mm:ss.ff</span></div>
                <div className="help-shortcuts__row"><kbd>Right Click Node</kbd><span>Change node curve mode</span></div>
                <div className="help-shortcuts__row"><kbd>Color Swatch</kbd><span>Apply color to selected track group</span></div>
                <div className="help-shortcuts__row"><kbd>Shift + Click Track</kbd><span>Select track range (anchor to clicked track)</span></div>
                <div className="help-shortcuts__row"><kbd>Ctrl/Cmd + Click Track</kbd><span>Toggle individual track selection</span></div>
                <div className="help-shortcuts__row"><kbd>Inspector: Open 3D Monitor</kbd><span>Open one independent 3D monitor window per 3D OSC track</span></div>
                <div className="help-shortcuts__row"><kbd>Drag 3D Space (Edit 3D OSC Node)</kbd><span>Orbit camera (XYZ RGB axis rotates with view)</span></div>
                <div className="help-shortcuts__row"><kbd>Wheel 3D Space (Edit 3D OSC Node)</kbd><span>Zoom 3D camera</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click 3D Space (Edit 3D OSC Node)</kbd><span>Reset 3D camera</span></div>
                <div className="help-shortcuts__row"><kbd>Drag 3D OSC Monitor</kbd><span>Orbit monitor camera</span></div>
                <div className="help-shortcuts__row"><kbd>Wheel 3D OSC Monitor</kbd><span>Zoom monitor camera</span></div>
                <div className="help-shortcuts__row"><kbd>Double Click 3D OSC Monitor</kbd><span>Reset monitor camera</span></div>
              </div>

              <div className="help-shortcuts__section">
                <div className="help-shortcuts__title">OSC Remote Control</div>
                <div className="help-shortcuts__row"><kbd>Settings &gt; OSC &gt; OSC Control Port</kbd><span>Set incoming control port</span></div>
                <div className="help-shortcuts__row"><kbd>Composition index</kbd><span>1-based order in the Compositions panel</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/5/select</kbd><span>Switch to Composition #5</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/rec 1</kbd><span>Switch to Composition #1 + REC On</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/rec 0</kbd><span>Switch to Composition #1 + REC Off</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/play 1</kbd><span>Switch to Composition #1 + Play On</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/play 0</kbd><span>Switch to Composition #1 + Play Off</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/stop 1</kbd><span>Switch to Composition #1 + Stop + locate 00:00:00.00</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/loop 1</kbd><span>Switch to Composition #1 + Loop On</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/loop 0</kbd><span>Switch to Composition #1 + Loop Off</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/cue 10</kbd><span>Switch to Composition #1 + jump to cue #10</span></div>
                <div className="help-shortcuts__row"><kbd>/OSConductor/Composition/1/cue/10</kbd><span>Alternative cue path format</span></div>
              </div>

              <div className="help-shortcuts__section help-shortcuts__section--brand">
                <div className="help-shortcuts__title">Brand & Copyright</div>
                <div className="help-brand">
                  <img src={nlInteractiveLogo} alt="NL Interactive logo" className="help-brand__logo" />
                  <div className="help-brand__name">NL Interactive</div>
                  <div className="help-brand__copyright">
                    Copyright © {COPYRIGHT_YEAR} NL Interactive. All rights reserved.
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {isSettingsOpen && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card modal__card--settings">
            <div className="modal__header">
              <div className="label">Settings</div>
              <button className="btn btn--ghost" onClick={() => setIsSettingsOpen(false)}>
                Close
              </button>
            </div>
            <div className="modal__content">
              <div className="settings-tabs" role="tablist" aria-label="Settings Categories">
                <button
                  className={`settings-tab ${settingsTab === 'project' ? 'is-active' : ''}`}
                  onClick={() => setSettingsTab('project')}
                  role="tab"
                  type="button"
                  aria-selected={settingsTab === 'project'}
                >
                  Project
                </button>
                <button
                  className={`settings-tab ${settingsTab === 'osc' ? 'is-active' : ''}`}
                  onClick={() => setSettingsTab('osc')}
                  role="tab"
                  type="button"
                  aria-selected={settingsTab === 'osc'}
                >
                  OSC
                </button>
                <button
                  className={`settings-tab ${settingsTab === 'audio' ? 'is-active' : ''}`}
                  onClick={() => setSettingsTab('audio')}
                  role="tab"
                  type="button"
                  aria-selected={settingsTab === 'audio'}
                >
                  Audio
                </button>
              </div>

              <div className="settings-panel__body">
                {settingsTab === 'project' && (
                  <div className="settings-section">
                    <div className="settings-section__title">Project Settings</div>
                    <div className="field">
                      <label>Project Name</label>
                      <input
                        className="input"
                        value={project.name ?? ''}
                        onChange={(event) =>
                          dispatch({ type: 'update-project', patch: { name: event.target.value } })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>FPS (OSC Send Rate)</label>
                      <NumberInput
                        className="input"
                       
                        min="1"
                        max="240"
                        step="1"
                        value={Number.isFinite(project.timebase.fps) ? project.timebase.fps : 30}
                        onChange={(event) =>
                          dispatch({
                            type: 'update-project',
                            patch: { timebase: { fps: Number(event.target.value) || 1 } },
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Project Length (hh:mm:ss.ff)</label>
                      <div className="field-grid field-grid--quad">
                        <NumberInput
                          className="input"
                         
                          min="0"
                          step="1"
                          placeholder="hh"
                          value={lengthParts.hours}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-project',
                              patch: {
                                view: {
                                  length: hmsfPartsToSeconds(
                                    Number(event.target.value) || 0,
                                    lengthParts.minutes,
                                    lengthParts.seconds,
                                    lengthParts.frames,
                                    syncFpsPreset.fps
                                  ),
                                },
                              },
                            })
                          }
                        />
                        <NumberInput
                          className="input"
                         
                          min="0"
                          max="59"
                          step="1"
                          placeholder="mm"
                          value={lengthParts.minutes}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-project',
                              patch: {
                                view: {
                                  length: hmsfPartsToSeconds(
                                    lengthParts.hours,
                                    Number(event.target.value) || 0,
                                    lengthParts.seconds,
                                    lengthParts.frames,
                                    syncFpsPreset.fps
                                  ),
                                },
                              },
                            })
                          }
                        />
                        <NumberInput
                          className="input"
                         
                          min="0"
                          max="59"
                          step="1"
                          placeholder="ss"
                          value={lengthParts.seconds}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-project',
                              patch: {
                                view: {
                                  length: hmsfPartsToSeconds(
                                    lengthParts.hours,
                                    lengthParts.minutes,
                                    Number(event.target.value) || 0,
                                    lengthParts.frames,
                                    syncFpsPreset.fps
                                  ),
                                },
                              },
                            })
                          }
                        />
                        <NumberInput
                          className="input"
                         
                          min="0"
                          max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                          step="1"
                          placeholder="ff"
                          value={lengthParts.frames}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-project',
                              patch: {
                                view: {
                                  length: hmsfPartsToSeconds(
                                    lengthParts.hours,
                                    lengthParts.minutes,
                                    lengthParts.seconds,
                                    Number(event.target.value) || 0,
                                    syncFpsPreset.fps
                                  ),
                                },
                              },
                            })
                          }
                        />
                      </div>
                    </div>

                    <div className="field">
                      <label>MIDI In / Out</label>
                      <div className="field-grid">
                        <select
                          className="input input--mono"
                          value={project.midi?.inputId ?? VIRTUAL_MIDI_INPUT_ID}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-project',
                              patch: { midi: { inputId: event.target.value } },
                            })
                          }
                        >
                          <option value={VIRTUAL_MIDI_INPUT_ID}>{VIRTUAL_MIDI_INPUT_NAME}</option>
                          {midiDevices.inputs.map((device) => (
                            <option key={device.id} value={device.id}>
                              {device.name}
                            </option>
                          ))}
                        </select>
                        <select
                          className="input input--mono"
                          value={project.midi?.outputId ?? VIRTUAL_MIDI_OUTPUT_ID}
                          onChange={(event) =>
                            dispatch({
                              type: 'update-project',
                              patch: { midi: { outputId: event.target.value } },
                            })
                          }
                        >
                          <option value={VIRTUAL_MIDI_OUTPUT_ID}>{VIRTUAL_MIDI_OUTPUT_NAME}</option>
                          {midiDevices.outputs.map((device) => (
                            <option key={device.id} value={device.id}>
                              {device.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {midiStatus.error && <div className="field__hint">{midiStatus.error}</div>}
                    </div>
                  </div>
                )}

                {settingsTab === 'osc' && (
                  <div className="settings-section">
                  <div className="settings-section__title">OSC Settings</div>
                  <div className="field">
                    <label>OSC Outputs</label>
                    <div className="settings-osc-outputs">
                      {oscOutputs.map((output, index) => (
                        <div key={output.id} className="settings-osc-output">
                          <div className="settings-osc-output__row">
                            <input
                              className="input"
                              value={output.name}
                              placeholder={normalizeOscOutputName('', index)}
                              onChange={(event) => patchOscOutput(output.id, { name: event.target.value })}
                            />
                            <input
                              className="input input--mono"
                              value={output.host}
                              placeholder="127.0.0.1"
                              onChange={(event) => patchOscOutput(output.id, { host: event.target.value })}
                            />
                            <NumberInput
                              className="input"
                              min="1"
                              max="65535"
                              step="1"
                              value={output.port}
                              onChange={(event) => patchOscOutput(output.id, { port: Number(event.target.value) || 1 })}
                            />
                            <button
                              className="btn btn--ghost btn--tiny"
                              onClick={() => removeOscOutput(output.id)}
                              disabled={oscOutputs.length <= 1}
                              title="Delete output"
                            >
                              Delete
                            </button>
                          </div>
                          {oscPortConflict.outputs[index] && (
                            <div className="field__hint field__hint--warn">
                              Port 5170 is reserved by Vite dev server. Please choose a different OSC output port.
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div className="settings-osc-outputs__actions">
                      <button className="btn btn--ghost btn--tiny" onClick={addOscOutput}>
                        Add OSC Output
                      </button>
                    </div>
                  </div>
                  <div className="field">
                    <label>OSC Listening Port</label>
                    <NumberInput
                      className="input"
                     
                      min="1"
                      max="65535"
                      step="1"
                      value={Number.isFinite(project.osc?.listenPort) ? project.osc.listenPort : 8999}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { osc: { listenPort: Number(event.target.value) || 1 } },
                        })
                      }
                    />
                    {oscPortConflict.listenPort && (
                      <div className="field__hint field__hint--warn">
                        Port 5170 is reserved by Vite dev server. Please choose a different OSC listening port.
                      </div>
                    )}
                    {oscListenState.status === 'error' && (
                      <div className="field__hint">{oscListenState.error || 'OSC listen error'}</div>
                    )}
                  </div>
                  <div className="field">
                    <label>OSC Control Port</label>
                    <NumberInput
                      className="input"
                     
                      min="1"
                      max="65535"
                      step="1"
                      value={Number.isFinite(project.osc?.controlPort) ? project.osc.controlPort : 8998}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { osc: { controlPort: Number(event.target.value) || 1 } },
                        })
                      }
                    />
                    {oscPortConflict.controlPort && (
                      <div className="field__hint field__hint--warn">
                        Port 5170 is reserved by Vite dev server. Please choose a different OSC control port.
                      </div>
                    )}
                  </div>
                  {hasOscPortConflict && (
                    <div className="field__hint field__hint--warn">
                      OSC output / listen / control ports must not use 5170.
                    </div>
                  )}
                  </div>
                )}

                {settingsTab === 'audio' && (
                  <div className="settings-section">
                  <div className="settings-section__title">Audio Settings</div>
                  <div className="field">
                    <label>Audio Output</label>
                    <select
                      className="input"
                      value={project.audio?.outputDeviceId ?? 'default'}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { audio: { outputDeviceId: event.target.value } },
                        })
                      }
                    >
                      <option value="default">Default</option>
                      {nativeAudioStatus.available
                        && typeof project.audio?.outputDeviceId === 'string'
                        && project.audio.outputDeviceId
                        && !project.audio.outputDeviceId.startsWith('native:')
                        && project.audio.outputDeviceId !== 'default' && (
                        <option value={project.audio.outputDeviceId}>
                          {`Legacy Browser Device (${project.audio.outputDeviceId.slice(0, 6)})`}
                        </option>
                      )}
                      {nativeAudioStatus.available && nativeAudioDevices.length > 0
                        ? nativeAudioDevices.map((device) => (
                          <option key={`native-${device.id}`} value={`native:${device.id}`}>
                            {`${device.name} (${Math.max(Number(device.outputChannels) || 0, 2)}ch)`}
                          </option>
                        ))
                        : audioOutputs.map((device) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Output ${device.deviceId.slice(0, 6)}`}
                          </option>
                        ))}
                    </select>
                    {audioOutputError && <div className="field__hint">{audioOutputError}</div>}
                    {nativeAudioStatus.available && nativeAudioStatus.api && (
                      <div className="field__hint">{`Native Audio: ${nativeAudioStatus.api}`}</div>
                    )}
                    {nativeAudioStatus.error && (
                      <div className="field__hint">{nativeAudioStatus.error}</div>
                    )}
                  </div>
                  <div className="field">
                    <label>Waveform Sample Rate (Hz)</label>
                    <NumberInput
                      className="input"
                     
                      min="8000"
                      max="192000"
                      step="1000"
                      value={Number.isFinite(project.audio?.sampleRate) ? project.audio.sampleRate : 48000}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { audio: { sampleRate: Number(event.target.value) || 48000 } },
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>Waveform Buffer Size</label>
                    <select
                      className="input"
                      value={Number.isFinite(project.audio?.bufferSize) ? project.audio.bufferSize : 1024}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { audio: { bufferSize: Number(event.target.value) || 1024 } },
                        })
                      }
                    >
                      {AUDIO_BUFFER_SIZES.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>LTC Input Device</label>
                    <select
                      className="input"
                      value={project.audio?.ltc?.inputDeviceId ?? 'default'}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { audio: { ltc: { inputDeviceId: event.target.value } } },
                        })
                      }
                    >
                      <option value="default">Default</option>
                      {audioInputs.map((device) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || `Input ${device.deviceId.slice(0, 6)}`}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>LTC Sync Channel</label>
                    <NumberInput
                      className="input"
                     
                      min="1"
                      max="64"
                      step="1"
                      value={Number.isFinite(project.audio?.ltc?.channel) ? project.audio.ltc.channel : 1}
                      onChange={(event) =>
                        dispatch({
                          type: 'update-project',
                          patch: { audio: { ltc: { channel: Number(event.target.value) || 1 } } },
                        })
                      }
                    />
                  </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {multiAddDialog && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card">
            <div className="modal__header">
              <div className="label">
                {multiAddDialog.kind === 'audio'
                  ? 'Add Multi Audio'
                    : multiAddDialog.kind === 'midi'
                      ? 'Add Multi MIDI CC'
                    : multiAddDialog.kind === 'group'
                      ? 'Add Multi Group'
                    : multiAddDialog.kind === 'midi-note'
                      ? 'Add Multi MIDI Note'
                    : multiAddDialog.kind === 'osc-array'
                      ? (multiAddDialog.singleAdd ? 'Add OSC Array' : 'Add Multi OSC Array')
                    : multiAddDialog.kind === 'osc-3d'
                      ? 'Add Multi 3D OSC'
                    : multiAddDialog.kind === 'osc-color'
                      ? 'Add Multi OSC Color'
                    : multiAddDialog.kind === 'osc-flag'
                      ? 'Add Multi OSC Flag'
                    : multiAddDialog.kind === 'dmx'
                      ? 'Add Multi DMX'
                      : multiAddDialog.kind === 'dmx-color'
                        ? 'Add Multi DMX Color'
                      : 'Add Multi OSC'}
              </div>
            </div>
            <div className="modal__content">
              {!multiAddDialog.singleAdd && (
                <div className="field">
                  <label>Track Count</label>
                  <NumberInput
                    className="input"
                    min="1"
                    max="256"
                    step="1"
                    value={multiAddDialog.count}
                    onChange={(event) =>
                      setMultiAddDialog({
                        ...multiAddDialog,
                        count: event.target.value,
                      })
                    }
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      handleConfirmMultiAdd();
                    }}
                  />
                </div>
              )}
              {(multiAddDialog.kind === 'dmx' || multiAddDialog.kind === 'dmx-color') && (
                <>
                  <div className="field">
                    <label>Art-Net IP</label>
                    <input
                      className="input input--mono"
                      value={typeof multiAddDialog.dmxHost === 'string' ? multiAddDialog.dmxHost : '127.0.0.1'}
                      onChange={(event) =>
                        setMultiAddDialog({
                          ...multiAddDialog,
                          dmxHost: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field-grid">
                    <div className="field">
                      <label>Universe</label>
                      <NumberInput
                        className="input"
                       
                        min="0"
                        max="32767"
                        step="1"
                        value={multiAddDialog.dmxUniverse}
                        onChange={(event) =>
                          setMultiAddDialog({
                            ...multiAddDialog,
                            dmxUniverse: event.target.value,
                          })
                        }
                      />
                    </div>
                    <div className="field">
                      <label>Start Channel</label>
                      <NumberInput
                        className="input"
                       
                        min="1"
                        max="512"
                        step="1"
                        value={multiAddDialog.dmxChannel}
                        onChange={(event) =>
                          setMultiAddDialog({
                            ...multiAddDialog,
                            dmxChannel: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  {multiAddDialog.kind === 'dmx-color' && (
                    <>
                      <div className="field">
                        <label>Fixture</label>
                        <select
                          className="input"
                          value={
                            multiAddDialog.dmxColorFixtureType === 'rgbw'
                            || multiAddDialog.dmxColorFixtureType === 'mapping'
                              ? multiAddDialog.dmxColorFixtureType
                              : 'rgb'
                          }
                          onChange={(event) =>
                            setMultiAddDialog({
                              ...multiAddDialog,
                              dmxColorFixtureType:
                                event.target.value === 'rgbw' || event.target.value === 'mapping'
                                  ? event.target.value
                                  : 'rgb',
                            })
                          }
                        >
                          <option value="rgb">RGB</option>
                          <option value="rgbw">RGBW</option>
                          <option value="mapping">Channel Mapping</option>
                        </select>
                      </div>
                      {multiAddDialog.dmxColorFixtureType === 'mapping' && (
                        <div className="field">
                          <label>RGB Mapping</label>
                          <select
                            className="input"
                            value={Number(multiAddDialog.dmxColorMappingChannels) === 3 ? '3' : '4'}
                            onChange={(event) =>
                              setMultiAddDialog({
                                ...multiAddDialog,
                                dmxColorMappingChannels: event.target.value === '3' ? '3' : '4',
                              })
                            }
                          >
                            <option value="3">3 Channels (RGB)</option>
                            <option value="4">4 Channels (RGBW)</option>
                          </select>
                        </div>
                      )}
                      <div className="field">
                        <label>Interval Channels</label>
                        <NumberInput
                          className="input"
                         
                          min="1"
                          max="512"
                          step="1"
                          value={multiAddDialog.dmxColorInterval}
                          onChange={(event) =>
                            setMultiAddDialog({
                              ...multiAddDialog,
                              dmxColorInterval: event.target.value,
                            })
                          }
                        />
                      </div>
                    </>
                  )}
                  <div className="field__hint">
                    {multiAddDialog.kind === 'dmx-color'
                      ? 'DMX Color uses Interval Channels for each track. If current universe overflows, auto jumps to next universe.'
                      : 'Channel start will auto-increment by track.'}
                  </div>
                </>
              )}
              {multiAddDialog.kind === 'osc-array' && (
                <div className="field">
                  <label>Array Values Per Node</label>
                  <NumberInput
                    className="input"
                    min="1"
                    max="20"
                    step="1"
                    value={multiAddDialog.oscArrayValueCount}
                    onChange={(event) =>
                      setMultiAddDialog({
                        ...multiAddDialog,
                        oscArrayValueCount: String(
                          clamp(Math.round(Number(event.target.value) || 1), 1, 20)
                        ),
                      })
                    }
                  />
                </div>
              )}
              {(multiAddDialog.kind === 'midi' || multiAddDialog.kind === 'midi-note') && (
                <>
                  <div className="field">
                    <label>MIDI Out Port</label>
                    <select
                      className="input"
                      value={typeof multiAddDialog.midiOutputId === 'string' && multiAddDialog.midiOutputId
                        ? multiAddDialog.midiOutputId
                        : (project.midi?.outputId || VIRTUAL_MIDI_OUTPUT_ID)}
                      onChange={(event) =>
                        setMultiAddDialog({
                          ...multiAddDialog,
                          midiOutputId: event.target.value,
                        })}
                    >
                      <option value={VIRTUAL_MIDI_OUTPUT_ID}>{VIRTUAL_MIDI_OUTPUT_NAME}</option>
                      {midiOutputOptions
                        .filter((device) => device.id !== VIRTUAL_MIDI_OUTPUT_ID)
                        .map((device) => (
                          <option key={device.id} value={device.id}>
                            {device.name}
                          </option>
                        ))}
                    </select>
                  </div>
                  <div className="field-grid">
                    <div className="field">
                      <label>Channel</label>
                      <NumberInput
                        className="input"
                       
                        min="1"
                        max="16"
                        step="1"
                        value={multiAddDialog.midiChannel}
                        onChange={(event) =>
                          setMultiAddDialog({
                            ...multiAddDialog,
                            midiChannel: event.target.value,
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>{multiAddDialog.kind === 'midi-note' ? 'Start Note' : 'Start CC'}</label>
                    <NumberInput
                      className="input"
                     
                      min="0"
                      max="127"
                      step="1"
                      value={multiAddDialog.midiStart}
                      onChange={(event) =>
                        setMultiAddDialog({
                          ...multiAddDialog,
                          midiStart: event.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field__hint">
                    {multiAddDialog.kind === 'midi-note'
                      ? 'MIDI note numbers will auto-increment by track.'
                      : 'MIDI CC numbers will auto-increment by track.'}
                  </div>
                </>
              )}
              <div className="modal__actions">
                <button
                  className="btn"
                  onClick={handleConfirmMultiAdd}
                  disabled={!canConfirmMultiAdd}
                >
                  Add
                </button>
                <button className="btn btn--ghost" onClick={() => setMultiAddDialog(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {audioChannelMapTrack && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card modal__card--audio-map">
            <div className="modal__header">
              <div className="label">{`Audio Channel Map - ${audioChannelMapTrack.name}`}</div>
            </div>
            <div className="modal__content">
              <div className="field">
                <label>Output Device</label>
                <select
                  className="input"
                  value={audioMapSelectedOutputDeviceId}
                  onChange={(event) => {
                    const nextOutputId = event.target.value || 'project-default';
                    setAudioChannelMapDraft((prev) => ({
                      outputDeviceId: nextOutputId,
                      channelMap: Array.isArray(prev?.channelMap)
                        ? prev.channelMap
                        : audioMapChannelMap,
                    }));
                  }}
                >
                  <option value="project-default">{`Project Default (${audioMapProjectOutputLabel})`}</option>
                  <option value="default">{`System Default (${getDetectedOutputChannels('default')}ch)`}</option>
                  {nativeAudioStatus.available && nativeAudioDevices.map((device) => {
                    const value = `native:${device.id}`;
                    return (
                      <option key={value} value={value}>
                        {`${device.name} (${getDetectedOutputChannels(value)}ch)`}
                      </option>
                    );
                  })}
                  {audioOutputs
                    .filter((device) => device.deviceId && device.deviceId !== 'default')
                    .map((device) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {`${device.label || `Output ${device.deviceId.slice(0, 6)}`} (${getDetectedOutputChannels(device.deviceId)}ch)`}
                      </option>
                    ))}
                </select>
              </div>
              <div className="field__hint">
                {`Detected source channels: ${audioMapSourceChannels} | Detected output channels: ${audioMapOutputChannelCount}`}
              </div>
              <div className="audio-map-matrix-wrap">
                <div
                  className="audio-map-matrix"
                  style={{
                    gridTemplateColumns: `90px repeat(${audioMapOutputChannelCount}, 30px)`,
                  }}
                >
                  <div className="audio-map-matrix__corner">In / Out</div>
                  {Array.from({ length: audioMapOutputChannelCount }, (_, index) => (
                    <div key={`audio-map-header-${index + 1}`} className="audio-map-matrix__header">
                      {index + 1}
                    </div>
                  ))}
                  {Array.from({ length: audioMapSourceChannels }, (_, rowIndex) => (
                    <React.Fragment key={`audio-map-row-${rowIndex + 1}`}>
                      <div className="audio-map-matrix__row-label">{`In ${rowIndex + 1}`}</div>
                      {Array.from({ length: audioMapOutputChannelCount }, (_, columnIndex) => {
                        const outputChannel = columnIndex + 1;
                        const active = audioMapChannelMap[rowIndex] === outputChannel;
                        return (
                          <button
                            key={`audio-map-cell-${rowIndex + 1}-${outputChannel}`}
                            type="button"
                            className={`audio-map-matrix__cell ${active ? 'is-active' : ''}`}
                            onClick={() => setAudioMapRoute(rowIndex, outputChannel)}
                          >
                            ●
                          </button>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <div className="field__hint">
                QLab-style patch matrix: click dots to patch each input channel to one output channel.
              </div>
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={closeAudioChannelMapDialog}>
                  Cancel
                </button>
                <button className="btn" onClick={confirmAudioChannelMap}>
                  OK
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingNode && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card">
            <div className="modal__header">
              <div className="label">
                {editingNode.mode === 'color'
                  ? 'Edit Node Color'
                  : (editingNode.mode === 'osc-flag'
                    ? 'Edit OSC Flag Node'
                    : (editingNode.mode === 'osc-array'
                      ? 'Edit OSC Array Node'
                      : (editingNode.mode === 'osc-3d'
                        ? 'Edit 3D OSC Node'
                        : (editingNode.mode === 'midi-note' ? 'Edit MIDI Note Node' : 'Edit Node Value'))))}
              </div>
              <button className="btn btn--ghost" onClick={() => setEditingNode(null)}>Close</button>
            </div>
            <div className="modal__content">
              {editingNode.mode === 'color' ? (
                <>
                  <div className="field">
                    <label>Node Time (hh:mm:ss.ff)</label>
                    <div className="field-grid field-grid--quad">
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="hh"
                        value={editingNode.colorHours}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, colorHours: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="mm"
                        value={editingNode.colorMinutes}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, colorMinutes: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max="59"
                        step="1"
                        placeholder="ss"
                        value={editingNode.colorSeconds}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, colorSeconds: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                        step="1"
                        placeholder="ff"
                        value={editingNode.colorFrames}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, colorFrames: event.target.value } : prev))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Color</label>
                    <InlineColorPicker
                      value={
                        typeof editingNode.color === 'string' && HEX_COLOR_RE.test(editingNode.color)
                          ? editingNode.color
                          : '#000000'
                      }
                      onChange={(nextColor) => {
                        setEditingNode((prev) => {
                          if (!prev) return prev;
                          return { ...prev, color: String(nextColor || '#000000').toLowerCase() };
                        });
                      }}
                    />
                  </div>
                </>
              ) : editingNode.mode === 'osc-array' ? (
                <>
                  <div className="field">
                    <label>Node Time (hh:mm:ss.ff)</label>
                    <div className="field-grid field-grid--quad">
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="hh"
                        value={editingNode.arrayHours}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, arrayHours: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="mm"
                        value={editingNode.arrayMinutes}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, arrayMinutes: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max="59"
                        step="1"
                        placeholder="ss"
                        value={editingNode.arraySeconds}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, arraySeconds: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                        step="1"
                        placeholder="ff"
                        value={editingNode.arrayFrames}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, arrayFrames: event.target.value } : prev))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Array Values</label>
                    <div className="field-grid field-grid--quad">
                      {(Array.isArray(editingNode.arrayValues) ? editingNode.arrayValues : []).map((item, index) => (
                        <div className="field" key={`osc-array-value-${index + 1}`}>
                          <label>{`Index ${index + 1}`}</label>
                          <NumberInput
                            className="input"
                            step={editingNode.valueType === 'int' ? '1' : '0.01'}
                            value={item}
                            onChange={(event) => {
                              setEditingNode((prev) => {
                                if (!prev) return prev;
                                const nextValues = Array.isArray(prev.arrayValues) ? [...prev.arrayValues] : [];
                                const raw = event.target.value;
                                if (prev.valueType === 'int') {
                                  const numeric = Number(raw);
                                  nextValues[index] = Number.isFinite(numeric) ? String(Math.round(numeric)) : raw;
                                } else {
                                  nextValues[index] = raw;
                                }
                                return { ...prev, arrayValues: nextValues };
                              });
                            }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : editingNode.mode === 'osc-3d' ? (
                (() => {
                  const osc3d = getOsc3dEditingState(editingNode);
                  const bounds = osc3d.bounds;
                  const preview = createOsc3dPreviewGeometry(osc3d.ratios, osc3dCamera);
                  return (
                    <>
                      <div className="field">
                        <label>Node Time (hh:mm:ss.ff)</label>
                        <div className="field-grid field-grid--quad">
                          <NumberInput
                            className="input"
                            min="0"
                            step="1"
                            placeholder="hh"
                            value={editingNode.osc3dHours}
                            onChange={(event) =>
                              setEditingNode((prev) => (prev ? { ...prev, osc3dHours: event.target.value } : prev))}
                          />
                          <NumberInput
                            className="input"
                            min="0"
                            step="1"
                            placeholder="mm"
                            value={editingNode.osc3dMinutes}
                            onChange={(event) =>
                              setEditingNode((prev) => (prev ? { ...prev, osc3dMinutes: event.target.value } : prev))}
                          />
                          <NumberInput
                            className="input"
                            min="0"
                            max="59"
                            step="1"
                            placeholder="ss"
                            value={editingNode.osc3dSeconds}
                            onChange={(event) =>
                              setEditingNode((prev) => (prev ? { ...prev, osc3dSeconds: event.target.value } : prev))}
                          />
                          <NumberInput
                            className="input"
                            min="0"
                            max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                            step="1"
                            placeholder="ff"
                            value={editingNode.osc3dFrames}
                            onChange={(event) =>
                              setEditingNode((prev) => (prev ? { ...prev, osc3dFrames: event.target.value } : prev))}
                          />
                        </div>
                      </div>
                      <div className="field">
                        <label>Value Type</label>
                        <select
                          className="input"
                          value={editingNode.valueType === 'int' ? 'int' : 'float'}
                          onChange={(event) =>
                            setEditingNode((prev) => {
                              if (!prev) return prev;
                              const nextType = event.target.value === 'int' ? 'int' : 'float';
                              if (nextType === prev.valueType) return prev;
                              const toText = (raw) => {
                                const numeric = Number(raw);
                                if (!Number.isFinite(numeric)) return raw;
                                return nextType === 'int'
                                  ? String(Math.round(numeric))
                                  : (Math.round(numeric * 100) / 100).toFixed(2);
                              };
                              return {
                                ...prev,
                                valueType: nextType,
                                xValue: toText(prev.xValue),
                                yValue: toText(prev.yValue),
                                zValue: toText(prev.zValue),
                              };
                            })}
                        >
                          <option value="float">Float (0.00)</option>
                          <option value="int">Integer</option>
                        </select>
                      </div>
                      <div className="field">
                        <label>XYZ</label>
                        <div className="field-grid field-grid--triple">
                          <div className="field">
                            <label>X</label>
                            <NumberInput
                              className="input"
                              step={editingNode.valueType === 'int' ? '1' : '0.01'}
                              value={editingNode.xValue}
                              onChange={(event) =>
                                setEditingNode((prev) => (prev ? { ...prev, xValue: event.target.value } : prev))}
                            />
                          </div>
                          <div className="field">
                            <label>Y</label>
                            <NumberInput
                              className="input"
                              step={editingNode.valueType === 'int' ? '1' : '0.01'}
                              value={editingNode.yValue}
                              onChange={(event) =>
                                setEditingNode((prev) => (prev ? { ...prev, yValue: event.target.value } : prev))}
                            />
                          </div>
                          <div className="field">
                            <label>Z</label>
                            <NumberInput
                              className="input"
                              step={editingNode.valueType === 'int' ? '1' : '0.01'}
                              value={editingNode.zValue}
                              onChange={(event) =>
                                setEditingNode((prev) => (prev ? { ...prev, zValue: event.target.value } : prev))}
                            />
                          </div>
                        </div>
                      </div>
                      <div className="osc3d-editor-grid">
                        <div className="osc3d-plane">
                          <div className="osc3d-plane__title">XY</div>
                          <div
                            className="osc3d-plane__surface"
                            onPointerDown={(event) => beginOsc3dPlaneDrag('xy', event)}
                          >
                            <div className="osc3d-plane__axis osc3d-plane__axis--horizontal">X</div>
                            <div className="osc3d-plane__axis osc3d-plane__axis--vertical">Y</div>
                            <div
                              className="osc3d-plane__point"
                              style={{
                                left: `${osc3d.ratios.x * 100}%`,
                                top: `${(1 - osc3d.ratios.y) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="osc3d-plane">
                          <div className="osc3d-plane__title">YZ</div>
                          <div
                            className="osc3d-plane__surface"
                            onPointerDown={(event) => beginOsc3dPlaneDrag('yz', event)}
                          >
                            <div className="osc3d-plane__axis osc3d-plane__axis--horizontal">Z</div>
                            <div className="osc3d-plane__axis osc3d-plane__axis--vertical">Y</div>
                            <div
                              className="osc3d-plane__point"
                              style={{
                                left: `${osc3d.ratios.z * 100}%`,
                                top: `${(1 - osc3d.ratios.y) * 100}%`,
                              }}
                            />
                          </div>
                        </div>
                        <div className="osc3d-preview osc3d-preview--large">
                          <div className="osc3d-preview__title">3D Space (Drag to Orbit · Wheel to Zoom)</div>
                          <div
                            className="osc3d-preview__stage osc3d-preview__stage--large"
                            onPointerDown={beginOsc3dCameraDrag}
                            onWheel={handleOsc3dCameraWheel}
                            onDoubleClick={() => setOsc3dCamera({ ...OSC3D_CAMERA_DEFAULT })}
                          >
                            <svg className="osc3d-preview__svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
                              {preview.axes.map((axis) => (
                                <g key={`axis-${axis.id}`}>
                                  <line
                                    x1={axis.from.x}
                                    y1={axis.from.y}
                                    x2={axis.tip.x}
                                    y2={axis.tip.y}
                                    className="osc3d-preview__axis-line"
                                    stroke={axis.color}
                                    style={{ opacity: clamp(axis.depth, 0.3, 1) }}
                                  />
                                  <text
                                    x={axis.labelPos.x}
                                    y={axis.labelPos.y}
                                    className="osc3d-preview__axis-label"
                                    fill={axis.color}
                                    style={{ opacity: clamp(axis.depth, 0.45, 1) }}
                                  >
                                    {axis.label}
                                  </text>
                                </g>
                              ))}
                              {preview.edges.map((edge) => (
                                <line
                                  key={edge.id}
                                  x1={edge.from.x}
                                  y1={edge.from.y}
                                  x2={edge.to.x}
                                  y2={edge.to.y}
                                  className="osc3d-preview__line"
                                  style={{ opacity: clamp(edge.depth, 0.25, 1) }}
                                />
                              ))}
                              <circle
                                cx={preview.point.x}
                                cy={preview.point.y}
                                r={1.7 + preview.point.depth * 2.2}
                                className="osc3d-preview__point-mark"
                              />
                            </svg>
                          </div>
                          <div className="field__hint">
                            {`X ${bounds.xMin.toFixed(2)}~${bounds.xMax.toFixed(2)} · Y ${bounds.yMin.toFixed(2)}~${bounds.yMax.toFixed(2)} · Z ${bounds.zMin.toFixed(2)}~${bounds.zMax.toFixed(2)} · Zoom ${osc3dCamera.zoom.toFixed(2)}x`}
                          </div>
                        </div>
                      </div>
                    </>
                  );
                })()
              ) : editingNode.mode === 'osc-flag' ? (
                <>
                  <div className="field">
                    <label>Flag Time (hh:mm:ss.ff)</label>
                    <div className="field-grid field-grid--quad">
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="hh"
                        value={editingNode.flagHours}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, flagHours: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="mm"
                        value={editingNode.flagMinutes}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, flagMinutes: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max="59"
                        step="1"
                        placeholder="ss"
                        value={editingNode.flagSeconds}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, flagSeconds: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                        step="1"
                        placeholder="ff"
                        value={editingNode.flagFrames}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, flagFrames: event.target.value } : prev))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>OSC Address</label>
                    <input
                      className="input input--mono"
                      value={editingNode.address ?? ''}
                      onChange={(event) =>
                        setEditingNode((prev) => (prev ? { ...prev, address: event.target.value } : prev))}
                    />
                  </div>
                  <div className="field">
                    <label>Trigger Value</label>
                    <NumberInput
                      className="input"
                      step={editingNode.valueType === 'int' ? '1' : '0.01'}
                      value={editingNode.value}
                      onChange={(event) =>
                        setEditingNode((prev) => {
                          if (!prev) return prev;
                          const raw = event.target.value;
                          if (prev.valueType === 'int') {
                            const numeric = Number(raw);
                            if (Number.isFinite(numeric)) {
                              return { ...prev, value: String(Math.round(numeric)) };
                            }
                          }
                          return { ...prev, value: raw };
                        })}
                    />
                  </div>
                  <div className="field">
                    <label>Value Type</label>
                    <select
                      className="input"
                      value={editingNode.valueType === 'int' ? 'int' : 'float'}
                      onChange={(event) =>
                        setEditingNode((prev) => (
                          prev
                            ? {
                              ...prev,
                              valueType: event.target.value === 'int' ? 'int' : 'float',
                              value: event.target.value === 'int' && Number.isFinite(Number(prev.value))
                                ? String(Math.round(Number(prev.value)))
                                : prev.value,
                            }
                            : prev
                        ))}
                    >
                      <option value="int">Integer</option>
                      <option value="float">Float (0.00)</option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Trigger Time (sec)</label>
                    <NumberInput
                      className="input"
                      min="0"
                      step="0.01"
                      value={editingNode.triggerTime}
                      onChange={(event) =>
                        setEditingNode((prev) => (prev ? { ...prev, triggerTime: event.target.value } : prev))}
                    />
                  </div>
                </>
              ) : editingNode.mode === 'midi-note' ? (
                <>
                  <div className="field">
                    <label>Note Time (hh:mm:ss.ff)</label>
                    <div className="field-grid field-grid--quad">
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="hh"
                        value={editingNode.noteHours}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, noteHours: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="mm"
                        value={editingNode.noteMinutes}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, noteMinutes: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max="59"
                        step="1"
                        placeholder="ss"
                        value={editingNode.noteSeconds}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, noteSeconds: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                        step="1"
                        placeholder="ff"
                        value={editingNode.noteFrames}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, noteFrames: event.target.value } : prev))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>{`MIDI Note (0-127) · ${formatMidiNoteLabel(editingNode.noteValue)}`}</label>
                    <NumberInput
                      className="input"
                      min="0"
                      max="127"
                      step="1"
                      value={editingNode.noteValue}
                      onChange={(event) =>
                        setEditingNode((prev) => (prev ? { ...prev, noteValue: event.target.value } : prev))}
                    />
                  </div>
                  <div className="field">
                    <label>Length (sec)</label>
                    <NumberInput
                      className="input"
                      min="0.01"
                      step="0.01"
                      value={editingNode.noteLength}
                      onChange={(event) =>
                        setEditingNode((prev) => (prev ? { ...prev, noteLength: event.target.value } : prev))}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="field">
                    <label>Node Time (hh:mm:ss.ff)</label>
                    <div className="field-grid field-grid--quad">
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="hh"
                        value={editingNode.valueHours}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, valueHours: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        step="1"
                        placeholder="mm"
                        value={editingNode.valueMinutes}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, valueMinutes: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max="59"
                        step="1"
                        placeholder="ss"
                        value={editingNode.valueSeconds}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, valueSeconds: event.target.value } : prev))}
                      />
                      <NumberInput
                        className="input"
                        min="0"
                        max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                        step="1"
                        placeholder="ff"
                        value={editingNode.valueFrames}
                        onChange={(event) =>
                          setEditingNode((prev) => (prev ? { ...prev, valueFrames: event.target.value } : prev))}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>Value</label>
                    <NumberInput
                      className="input"
                      step={
                        editingNodeTrack?.kind === 'midi'
                        || editingNodeTrack?.kind === 'dmx'
                        || editingNodeTrack?.kind === 'dmx-color'
                        || (editingNodeTrack?.kind === 'osc' && editingNode.valueType === 'int')
                          ? '1'
                          : '0.01'
                      }
                      value={editingNode.value}
                      onChange={(event) =>
                        setEditingNode((prev) => {
                          if (!prev) return prev;
                          const raw = event.target.value;
                          if (editingNodeTrack?.kind === 'midi') {
                            const numeric = Number(raw);
                            return { ...prev, value: Number.isFinite(numeric) ? String(Math.round(numeric)) : raw };
                          }
                          if (editingNodeTrack?.kind === 'dmx' || editingNodeTrack?.kind === 'dmx-color') {
                            const numeric = Number(raw);
                            return { ...prev, value: Number.isFinite(numeric) ? String(Math.round(numeric)) : raw };
                          }
                          if (editingNodeTrack?.kind === 'osc' && prev.valueType === 'int') {
                            const numeric = Number(raw);
                            return { ...prev, value: Number.isFinite(numeric) ? String(Math.round(numeric)) : raw };
                          }
                          return { ...prev, value: raw };
                        })}
                    />
                  </div>
                </>
              )}
              <div className="modal__actions">
                <button className="btn btn--ghost" onClick={() => setEditingNode(null)}>Cancel</button>
                <button className="btn" onClick={handleSaveNodeValue}>Save</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingCue && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card">
            <div className="modal__header">
              <div className="label">Edit Cue Time</div>
            </div>
            <div className="modal__content">
              <div className="field">
                <label>Time (hh:mm:ss.ff)</label>
                <div className="field-grid field-grid--quad">
                  <NumberInput
                    className="input"
                    min="0"
                    step="1"
                    placeholder="hh"
                    value={editingCue.hours}
                    onChange={(event) =>
                      setEditingCue({
                        ...editingCue,
                        hours: Number(event.target.value) || 0,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    step="1"
                    placeholder="mm"
                    value={editingCue.minutes}
                    onChange={(event) =>
                      setEditingCue({
                        ...editingCue,
                        minutes: Number(event.target.value) || 0,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="ss"
                    value={editingCue.seconds}
                    onChange={(event) =>
                      setEditingCue({
                        ...editingCue,
                        seconds: Number(event.target.value) || 0,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                    step="1"
                    placeholder="ff"
                    value={editingCue.frames}
                    onChange={(event) =>
                      setEditingCue({
                        ...editingCue,
                        frames: Number(event.target.value) || 0,
                      })
                    }
                  />
                </div>
              </div>
              <div className="modal__actions">
                <button className="btn" onClick={handleSaveCueTime}>Save</button>
                <button className="btn btn--ghost" onClick={() => setEditingCue(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingLoopRange && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card">
            <div className="modal__header">
              <div className="label">Edit Loop Range</div>
            </div>
            <div className="modal__content">
              <div className="field">
                <label>Start (hh:mm:ss.ff)</label>
                <div className="field-grid field-grid--quad">
                  <NumberInput
                    className="input"
                    min="0"
                    step="1"
                    placeholder="hh"
                    value={editingLoopRange.startHours}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        startHours: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="mm"
                    value={editingLoopRange.startMinutes}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        startMinutes: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="ss"
                    value={editingLoopRange.startSeconds}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        startSeconds: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                    step="1"
                    placeholder="ff"
                    value={editingLoopRange.startFrames}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        startFrames: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="field">
                <label>End (hh:mm:ss.ff)</label>
                <div className="field-grid field-grid--quad">
                  <NumberInput
                    className="input"
                    min="0"
                    step="1"
                    placeholder="hh"
                    value={editingLoopRange.endHours}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        endHours: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="mm"
                    value={editingLoopRange.endMinutes}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        endMinutes: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="ss"
                    value={editingLoopRange.endSeconds}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        endSeconds: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                    step="1"
                    placeholder="ff"
                    value={editingLoopRange.endFrames}
                    onChange={(event) =>
                      setEditingLoopRange({
                        ...editingLoopRange,
                        endFrames: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="modal__actions">
                <button className="btn" onClick={handleSaveLoopRange}>Save</button>
                <button className="btn btn--ghost" onClick={() => setEditingLoopRange(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editingAudioClip && (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal__card">
            <div className="modal__header">
              <div className="label">Edit Audio Clip Start</div>
            </div>
            <div className="modal__content">
              <div className="field">
                <label>Start (hh:mm:ss.ff)</label>
                <div className="field-grid field-grid--quad">
                  <NumberInput
                    className="input"
                    min="0"
                    step="1"
                    placeholder="hh"
                    value={editingAudioClip.hours}
                    onChange={(event) =>
                      setEditingAudioClip({
                        ...editingAudioClip,
                        hours: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="mm"
                    value={editingAudioClip.minutes}
                    onChange={(event) =>
                      setEditingAudioClip({
                        ...editingAudioClip,
                        minutes: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max="59"
                    step="1"
                    placeholder="ss"
                    value={editingAudioClip.seconds}
                    onChange={(event) =>
                      setEditingAudioClip({
                        ...editingAudioClip,
                        seconds: event.target.value,
                      })
                    }
                  />
                  <NumberInput
                    className="input"
                    min="0"
                    max={Math.max(Math.round(syncFpsPreset.fps) - 1, 0)}
                    step="1"
                    placeholder="ff"
                    value={editingAudioClip.frames}
                    onChange={(event) =>
                      setEditingAudioClip({
                        ...editingAudioClip,
                        frames: event.target.value,
                      })
                    }
                  />
                </div>
              </div>
              <div className="modal__actions">
                <button className="btn" onClick={handleSaveAudioClipStart}>Save</button>
                <button className="btn btn--ghost" onClick={() => setEditingAudioClip(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={handleFileChange}
        style={{ display: 'none' }}
      />

      <div
        className={`workspace${isCompositionsVisible ? '' : ' workspace--no-compositions'}${isInspectorVisible ? '' : ' workspace--no-inspector'}`}
      >
        {isCompositionsVisible && (
          <aside className="composition-panel">
            <div className="panel-header">
              <div className="label">Compositions</div>
              <div className="composition-panel__actions">
                <button
                  className="btn btn--ghost btn--tiny btn--symbol"
                  onClick={handleAddComposition}
                  title="Add composition"
                >
                  +
                </button>
                <button
                  className="btn btn--ghost btn--tiny btn--symbol"
                  onClick={handleDeleteComposition}
                  disabled={compositions.length <= 1}
                  title="Delete active composition"
                >
                  -
                </button>
              </div>
            </div>
            <div className="composition-panel__body">
              {compositions.length === 0 ? (
                <div className="composition-panel__empty">No compositions</div>
              ) : (
                compositions.map((composition, index) => (
                  <div
                    key={composition.id}
                    className={`composition-row ${composition.id === activeCompositionId ? 'is-active' : ''} ${dragCompositionId === composition.id ? 'is-dragging' : ''} ${compositionDropTarget?.id === composition.id ? `is-drop-${compositionDropTarget.position}` : ''}`}
                    onClick={() => {
                      if (editingCompositionId === composition.id) return;
                      handleSwitchComposition(composition.id);
                    }}
                    onDoubleClick={() => beginRenameComposition(composition)}
                    onKeyDown={(event) => {
                      if (editingCompositionId === composition.id) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleSwitchComposition(composition.id);
                      }
                    }}
                    draggable={editingCompositionId !== composition.id}
                    onDragStart={(event) => {
                      if (editingCompositionId === composition.id) {
                        event.preventDefault();
                        return;
                      }
                      setDragCompositionId(composition.id);
                      setCompositionDropTarget(null);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', composition.id);
                    }}
                    onDragOver={(event) => {
                      if (!dragCompositionId || dragCompositionId === composition.id) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      const position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                      setCompositionDropTarget({ id: composition.id, position });
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const sourceId = dragCompositionId || event.dataTransfer.getData('text/plain');
                      if (sourceId && sourceId !== composition.id) {
                        const rect = event.currentTarget.getBoundingClientRect();
                        const fallbackPosition = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                        const position = compositionDropTarget?.id === composition.id
                          ? compositionDropTarget.position
                          : fallbackPosition;
                        handleMoveComposition(sourceId, composition.id, position);
                      }
                      setDragCompositionId(null);
                      setCompositionDropTarget(null);
                    }}
                    onDragEnd={() => {
                      setDragCompositionId(null);
                      setCompositionDropTarget(null);
                    }}
                    role="button"
                    tabIndex={0}
                    title="Click to switch / Double-click to rename / Drag to reorder"
                  >
                    <span className="composition-row__index">{String(index + 1).padStart(2, '0')}</span>
                    {editingCompositionId === composition.id ? (
                      <input
                        className="input composition-row__name-input"
                        value={editingCompositionName}
                        autoFocus
                        onChange={(event) => setEditingCompositionName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') {
                            event.preventDefault();
                            commitRenameComposition();
                            return;
                          }
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            cancelRenameComposition();
                          }
                        }}
                        onBlur={commitRenameComposition}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <span className="composition-row__name">{composition.name}</span>
                    )}
                    <span className="composition-row__meta">
                      {formatHmsfTimecode(composition.view?.length || 0, syncFpsPreset.fps)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}

        <div className="tracks-pane">
          <aside className="track-list track-list--header">
            <div className="panel-header track-list-header-panel">
              <div className="track-header-row track-header-row--cue">
                <div className="track-cue-controls">
                  <span className="timeline-controls__label">Cue</span>
                  <div className="timeline-controls__buttons timeline-controls__buttons--cue">
                    <button
                      className="btn btn--unit"
                      onClick={() => handleCueStep(-1)}
                      disabled={!project.cues?.length}
                      title="Jump to previous cue"
                    >
                      {'<'}
                    </button>
                    <button
                      className="btn btn--unit"
                      onClick={() => handleCueStep(1)}
                      disabled={!project.cues?.length}
                      title="Jump to next cue"
                    >
                      {'>'}
                    </button>
                    <button
                      className="btn btn--unit"
                      onClick={handleCueAddAtPlayhead}
                      title="Add cue at playhead"
                    >
                      +
                    </button>
                    <button
                      className="btn btn--unit"
                      onClick={handleCueDeleteAtPlayhead}
                      disabled={!project.cues?.length}
                      title="Delete cue at playhead"
                    >
                      -
                    </button>
                  </div>
                </div>
              </div>
              <div className="track-header-row track-header-row--actions">
                <div className="label">Tracks</div>
                <div className="tracks-actions">
                  <div className="tracks-actions__group">
                    <div className="tracks-add-wrap">
                      <button
                        className="btn btn--tiny btn--symbol"
                        title="Add track (hold Alt/Option for Multi Add menu)"
                        aria-label="Add track. Hold Alt or Option for multi add menu."
                        onClick={(event) => {
                          event.stopPropagation();
                          const mode = event.altKey ? 'multi' : 'single';
                          if (isAddTrackMenuOpen && addTrackMenuMode === mode) {
                            setIsAddTrackMenuOpen(false);
                            return;
                          }
                          setAddTrackMenuMode(mode);
                          setIsAddTrackMenuOpen(true);
                        }}
                        onPointerDown={(event) => event.stopPropagation()}
                      >
                        +
                      </button>
                      {isAddTrackMenuOpen && (
                        <div
                          className="tracks-add-menu"
                          onPointerDown={(event) => event.stopPropagation()}
                        >
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('osc');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'osc' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi OSC' : 'Add OSC'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('osc-flag');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'osc-flag' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi OSC Flag' : 'Add OSC Flag'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('osc-array');
                                return;
                              }
                              openMultiAddDialog('osc-array', {
                                count: '1',
                                singleAdd: true,
                              });
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi OSC Array' : 'Add OSC Array'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('osc-3d');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'osc-3d' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi 3D OSC' : 'Add 3D OSC'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('osc-color');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'osc-color' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi OSC Color' : 'Add OSC Color'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('audio');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'audio' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi Audio' : 'Add Audio'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('midi');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'midi' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi MIDI CC' : 'Add MIDI CC'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('midi-note');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'midi-note' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi MIDI Note' : 'Add MIDI Note'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('dmx');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'dmx' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi DMX' : 'Add DMX'}
                          </button>
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('dmx-color');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'dmx-color' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi DMX Color' : 'Add DMX Color'}
                          </button>
                          <div className="tracks-add-menu__separator" />
                          <button
                            className="tracks-add-menu__item"
                            onClick={() => {
                              if (addTrackMenuMode === 'multi') {
                                openMultiAddDialog('group');
                                return;
                              }
                              dispatch({ type: 'add-track', kind: 'group' });
                              setIsAddTrackMenuOpen(false);
                            }}
                          >
                            {addTrackMenuMode === 'multi' ? 'Add Multi Group' : 'Add Group'}
                          </button>
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn--ghost btn--tiny btn--symbol"
                      onClick={handleDeleteTrack}
                      disabled={!selectedTrackId}
                    >
                      -
                    </button>
                  </div>
                  <div className="tracks-actions__group">
                    <button
                      className="btn btn--ghost btn--tiny btn--symbol tracks-clear-btn"
                      onClick={clearAllTrackSolo}
                      disabled={!hasAnyTrackSolo}
                      title="Clear all solo"
                    >
                      S
                    </button>
                    <button
                      className="btn btn--ghost btn--tiny btn--symbol tracks-clear-btn"
                      onClick={clearAllTrackMute}
                      disabled={!hasAnyTrackMute}
                      title="Clear all mute"
                    >
                      M
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </aside>
          <div ref={timelineWidthHostRef} className="timeline-header-wrap">
            <TimelineHeader
              view={project.view}
              fps={syncFpsPreset.fps}
              playhead={playhead}
              width={timelineWidth}
              onSeek={handleSeek}
              onScroll={handleScroll}
              cues={cueList}
              onCueEdit={handleEditCue}
              onCueAdd={handleCueAdd}
              onCueMove={handleCueMove}
              onCueDelete={handleCueDelete}
              loopEnabled={Boolean(project.view.loopEnabled)}
              loopStart={Number(project.view.loopStart) || 0}
              loopEnd={Number(project.view.loopEnd) || 0}
              onLoopRangeChange={handleLoopRangeChange}
              onLoopEdit={handleOpenLoopRangeEditor}
            />
          </div>

          <div className="tracks-scroll">
            <div className="tracks-scroll__grid">
              <div className="track-list track-list--body">
                <div className="track-list__body track-list__body--static">
                  {visibleTracks.map((track, index) => {
                    const meterLevel = getTrackMeterLevel(track);
                    const meterLevelClass = getMeterLevelClass(meterLevel);
                    const groupHostId = groupHostByTrackId.get(track.id);
                    const isGroupedChild = Boolean(groupHostId && track.kind !== 'group');
                    const rowHeight = getRenderedTrackHeight(track);
                    const groupedChildCompact = isGroupedChild && rowHeight <= 66;
                    const effectiveTrackInfoDensity = isGroupedChild
                      ? (
                        groupedChildCompact
                          ? 'compact'
                          : (
                            trackInfoDensity === 'full' && rowHeight >= 88
                              ? 'full'
                              : 'medium'
                          )
                      )
                      : trackInfoDensity;
                    const parentGroupName = isGroupedChild
                      ? (groupTrackById.get(groupHostId)?.name || 'Group')
                      : '';
                    const groupedChildSummary = isGroupedChild ? getGroupedChildSummary(track) : '';
                    const renderDetailedMeta = !isGroupedChild || effectiveTrackInfoDensity === 'full';
                    return (
                    <div
                      key={track.id}
                      className={`track-row track-row--${effectiveTrackInfoDensity} ${isGroupedChild ? 'track-row--group-child' : ''} ${selectedTrackId === track.id ? 'is-selected' : ''} ${selectedTrackIds.includes(track.id) ? 'is-group-selected' : ''} ${dragTrackIds.includes(track.id) ? 'is-dragging' : ''} ${dropTarget?.id === track.id ? `is-drop-${dropTarget.position}` : ''}`}
                      onClick={(event) => handleTrackRowSelect(track.id, event)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          handleTrackRowSelect(track.id, event);
                        }
                      }}
                      draggable={editingTrackNameId !== track.id}
                      onDragStart={(event) => {
                        if (editingTrackNameId === track.id) {
                          event.preventDefault();
                          return;
                        }
                        const selectedIdsInOrder =
                          selectedTrackIds.includes(track.id) && selectedTrackIds.length > 1
                            ? visibleTrackIdsInOrder.filter((id) => selectedTrackIds.includes(id))
                            : [track.id];
                        const groupIds = expandTrackIdsWithGroupMembers(selectedIdsInOrder);
                        setDragTrackId(track.id);
                        setDragTrackIds(groupIds);
                        setDropTarget(null);
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', track.id);
                        event.dataTransfer.setData('application/x-osconductor-track-ids', JSON.stringify(groupIds));
                      }}
                      onDragOver={(event) => {
                        if (!dragTrackId) return;
                        if (dragTrackIds.includes(track.id)) return;
                        event.preventDefault();
                        const rect = event.currentTarget.getBoundingClientRect();
                        const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
                        const sourceIds = dragTrackIds.length ? dragTrackIds : [dragTrackId];
                        const draggingContainsGroup = sourceIds.some((id) => {
                          const sourceTrack = project.tracks.find((item) => item.id === id);
                          return sourceTrack?.kind === 'group';
                        });
                        const canDropInside = track.kind === 'group' && !draggingContainsGroup;
                        let position = 'after';
                        if (canDropInside && ratio >= 0.18 && ratio <= 0.82) {
                          position = 'inside';
                        } else if (dragTrackIds.length <= 1) {
                          position = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                        }
                        setDropTarget({ id: track.id, position });
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        let sourceIds = dragTrackIds;
                        if (!sourceIds.length) {
                          const rawIds = event.dataTransfer.getData('application/x-osconductor-track-ids');
                          if (rawIds) {
                            try {
                              const parsed = JSON.parse(rawIds);
                              if (Array.isArray(parsed)) {
                                sourceIds = parsed.filter((id) => typeof id === 'string' && id);
                              }
                            } catch (error) {
                              // Ignore invalid drag payload.
                            }
                          }
                        }
                        if (!sourceIds.length) {
                          const sourceId = dragTrackId || event.dataTransfer.getData('text/plain');
                          if (sourceId) {
                            sourceIds = [sourceId];
                          }
                        }
                        if (sourceIds.length) {
                          const rect = event.currentTarget.getBoundingClientRect();
                          const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1);
                          const draggingContainsGroup = sourceIds.some((id) => {
                            const sourceTrack = project.tracks.find((item) => item.id === id);
                            return sourceTrack?.kind === 'group';
                          });
                          const canDropInside = track.kind === 'group' && !draggingContainsGroup;
                          const fallbackPosition =
                            canDropInside && ratio >= 0.18 && ratio <= 0.82
                              ? 'inside'
                              : (event.clientY < rect.top + rect.height / 2 ? 'before' : 'after');
                          let position = dropTarget?.id === track.id ? dropTarget.position : fallbackPosition;
                          if (sourceIds.length > 1 && track.kind !== 'group' && position !== 'inside') {
                            position = 'after';
                          }
                          if (position === 'inside' && track.kind === 'group') {
                            handleMoveTracksIntoGroup(sourceIds, track.id);
                          } else if (track.kind === 'group' && (position === 'before' || position === 'after')) {
                            handleMoveTracksAtGroupBoundary(sourceIds, track.id, position);
                          } else if (sourceIds.length > 1) {
                            handleMoveTrackGroup(sourceIds, track.id, 'after');
                          } else {
                            handleMoveTrack(sourceIds[0], track.id, position);
                          }
                        }
                        setDragTrackId(null);
                        setDragTrackIds([]);
                        setDropTarget(null);
                      }}
                      onDragEnd={() => {
                        setDragTrackId(null);
                        setDragTrackIds([]);
                        setDropTarget(null);
                      }}
                      role="button"
                      tabIndex={0}
                      style={{
                        height: rowHeight,
                        '--track-accent': typeof track.color === 'string' ? track.color : '#5dd8c7',
                      }}
                    >
                      <div className="track-row__title">
                        <label
                          className="track-row__color"
                          title="Track color"
                          onPointerDown={(event) => event.stopPropagation()}
                          onClick={(event) => event.stopPropagation()}
                          onDragStart={(event) => event.preventDefault()}
                        >
                          <input
                            type="color"
                            value={typeof track.color === 'string' ? track.color : '#5dd8c7'}
                            onChange={(event) => {
                              handleTrackColorChange(track.id, event.target.value);
                            }}
                          />
                        </label>
                        {isGroupedChild && <span className="track-row__child-marker">↳</span>}
                        {!isGroupedChild && (
                          <span className="track-row__index">{String(index + 1).padStart(2, '0')}</span>
                        )}
                        {editingTrackNameId === track.id ? (
                          <input
                            className="input track-row__name-input"
                            value={editingTrackName}
                            autoFocus
                            onChange={(event) => setEditingTrackName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                commitTrackInlineRename(track.id);
                                return;
                              }
                              if (event.key === 'Escape') {
                                event.preventDefault();
                                cancelTrackInlineRename();
                              }
                            }}
                            onBlur={() => commitTrackInlineRename(track.id)}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => event.stopPropagation()}
                          />
                        ) : (
                          <button
                            className="track-row__name-btn"
                            onClick={(event) => {
                              event.stopPropagation();
                              beginTrackInlineRename(track);
                            }}
                            title="Click to rename"
                          >
                            <span className="track-row__name">{track.name}</span>
                          </button>
                        )}
                      </div>
                      {effectiveTrackInfoDensity !== 'compact' && (
                        <div className="track-row__meta">
                          {isGroupedChild && <span>{`In ${parentGroupName}`}</span>}
                          {isGroupedChild && groupedChildSummary && (
                            <span className="track-row__group-summary">{groupedChildSummary}</span>
                          )}
                          {renderDetailedMeta && track.kind === 'group' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>Group Track</span>
                                <span>{track.group?.expanded !== false ? 'Expanded' : 'Collapsed'}</span>
                                <span>{(groupMembersById.get(track.id) || []).length} tracks</span>
                              </>
                            ) : (
                              <>
                                <span>Group Track</span>
                                <span>{(groupMembersById.get(track.id) || []).length} tracks</span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'audio' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>Audio Track</span>
                                <span className="track-row__osc">{track.audio?.name || 'No audio loaded'}</span>
                                <span>Volume: {Number(track.audio?.volume ?? 1).toFixed(2)}</span>
                              </>
                            ) : (
                              <>
                                <span>Audio Track</span>
                                <span>Volume: {Number(track.audio?.volume ?? 1).toFixed(2)}</span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'osc' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>OSC Track</span>
                                <span>{track.min} to {track.max}</span>
                                <span className="track-row__osc">
                                  {track.oscAddress}
                                  {' · '}
                                  {oscOutputLabelMap.get(track.oscOutputId) || oscOutputLabelMap.get(defaultOscOutput.id)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>OSC Track</span>
                                <span>{track.min} to {track.max}</span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'osc-array' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>OSC Array Track</span>
                                <span>{`Values ${clamp(Math.round(Number(track.oscArray?.valueCount) || 5), 1, 20)} | ${Number(track.min ?? 0).toFixed(2)} to ${Number(track.max ?? 1).toFixed(2)}`}</span>
                                <span className="track-row__osc">
                                  {track.oscAddress}
                                  {' · '}
                                  {oscOutputLabelMap.get(track.oscOutputId) || oscOutputLabelMap.get(defaultOscOutput.id)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>OSC Array Track</span>
                                <span>{`Values ${clamp(Math.round(Number(track.oscArray?.valueCount) || 5), 1, 20)}`}</span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'osc-3d' && (
                            (() => {
                              const bounds = normalizeOsc3dBounds(track);
                              const outputLabel = oscOutputLabelMap.get(track.oscOutputId) || oscOutputLabelMap.get(defaultOscOutput.id);
                              return effectiveTrackInfoDensity === 'full' ? (
                                <>
                                  <span>3D OSC Track</span>
                                  <span>
                                    {`X ${bounds.xMin.toFixed(2)}~${bounds.xMax.toFixed(2)} · Y ${bounds.yMin.toFixed(2)}~${bounds.yMax.toFixed(2)} · Z ${bounds.zMin.toFixed(2)}~${bounds.zMax.toFixed(2)}`}
                                  </span>
                                  <span className="track-row__osc">
                                    {track.oscAddress}
                                    {' · '}
                                    {outputLabel}
                                  </span>
                                </>
                              ) : (
                                <>
                                  <span>3D OSC Track</span>
                                  <span>{`XYZ ${track.oscValueType === 'int' ? 'int' : 'float'}`}</span>
                                </>
                              );
                            })()
                          )}
                          {renderDetailedMeta && track.kind === 'osc-flag' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>OSC Flag Track</span>
                                <span className="track-row__osc">
                                  {track.oscAddress}
                                  {' · '}
                                  {oscOutputLabelMap.get(track.oscOutputId) || oscOutputLabelMap.get(defaultOscOutput.id)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>OSC Flag Track</span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'osc-color' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>OSC Color Track</span>
                                <span>
                                  {(track.oscColor?.fixtureType === 'rgbw' ? 'RGBW' : 'RGB')}
                                  {' '}
                                  {(track.oscColor?.outputRange === 'unit' ? '0-1' : '0-255')}
                                </span>
                                <span className="track-row__osc">
                                  {track.oscAddress}
                                  {' · '}
                                  {oscOutputLabelMap.get(track.oscOutputId) || oscOutputLabelMap.get(defaultOscOutput.id)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>OSC Color Track</span>
                                <span>
                                  {(track.oscColor?.fixtureType === 'rgbw' ? 'RGBW' : 'RGB')}
                                  {' '}
                                  {(track.oscColor?.outputRange === 'unit' ? '0-1' : '0-255')}
                                </span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'midi' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>MIDI CC Track</span>
                                <span>
                                  Ch {Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1)))}
                                  {' · '}
                                  CC {Math.max(0, Math.min(127, Math.round(Number(track.midi?.controlNumber) || 1)))}
                                </span>
                                <span className="track-row__osc">
                                  {midiOutputNameMap.get(getMidiTrackOutputId(track)) || getMidiTrackOutputId(track)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>MIDI CC Track</span>
                                <span>
                                  Ch {Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1)))}
                                </span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'midi-note' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>MIDI Note Track</span>
                                <span>
                                  Ch {Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1)))}
                                </span>
                                <span className="track-row__osc">
                                  {midiOutputNameMap.get(getMidiTrackOutputId(track)) || getMidiTrackOutputId(track)}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>MIDI Note Track</span>
                                <span>
                                  Ch {Math.max(1, Math.min(16, Math.round(Number(track.midi?.channel) || 1)))}
                                </span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'dmx' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>DMX Track</span>
                                <span>
                                  U{Math.max(0, Math.min(32767, Math.round(Number(track.dmx?.universe) || 0)))}
                                  {' '}
                                  Ch {Math.max(1, Math.min(512, Math.round(Number(track.dmx?.channel) || 1)))}
                                </span>
                                <span className="track-row__osc">
                                  Art-Net {typeof track.dmx?.host === 'string' && track.dmx.host.trim()
                                    ? track.dmx.host.trim()
                                    : '127.0.0.1'}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>DMX Track</span>
                                <span>
                                  U{Math.max(0, Math.min(32767, Math.round(Number(track.dmx?.universe) || 0)))}
                                  {' '}
                                  Ch {Math.max(1, Math.min(512, Math.round(Number(track.dmx?.channel) || 1)))}
                                </span>
                              </>
                            )
                          )}
                          {renderDetailedMeta && track.kind === 'dmx-color' && (
                            effectiveTrackInfoDensity === 'full' ? (
                              <>
                                <span>DMX Color Track</span>
                                <span>
                                  U{Math.max(0, Math.min(32767, Math.round(Number(track.dmxColor?.universe) || 0)))}
                                  {' '}
                                  ChStart {Math.max(1, Math.min(512, Math.round(Number(track.dmxColor?.channelStart) || 1)))}
                                  {' '}
                                  {(track.dmxColor?.fixtureType === 'rgbw' || track.dmxColor?.fixtureType === 'mapping'
                                    ? track.dmxColor.fixtureType
                                    : 'rgb').toUpperCase()}
                                </span>
                                <span className="track-row__osc">
                                  Art-Net {typeof track.dmxColor?.host === 'string' && track.dmxColor.host.trim()
                                    ? track.dmxColor.host.trim()
                                    : '127.0.0.1'}
                                </span>
                              </>
                            ) : (
                              <>
                                <span>DMX Color Track</span>
                                <span>
                                  U{Math.max(0, Math.min(32767, Math.round(Number(track.dmxColor?.universe) || 0)))}
                                  {' '}
                                  ChStart {Math.max(1, Math.min(512, Math.round(Number(track.dmxColor?.channelStart) || 1)))}
                                </span>
                              </>
                            )
                          )}
                        </div>
                      )}
                      {track.kind === 'audio' && (
                        <div
                          className={`track-row__meter ${meterLevel > 0.001 ? `is-active ${meterLevelClass}` : ''}`}
                          aria-hidden="true"
                        >
                          <div className="track-row__meter-fill" style={{ width: `${Math.round(meterLevel * 100)}%` }} />
                        </div>
                      )}
                      <div className="track-row__controls">
                        {track.kind === 'group' ? (
                          <button
                            className={`track-pill track-pill--group ${track.group?.expanded !== false ? 'is-active' : ''}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              toggleGroupExpanded(track.id);
                            }}
                            title={track.group?.expanded !== false ? 'Collapse group' : 'Expand group'}
                          >
                            {track.group?.expanded !== false ? '▾' : '▸'}
                          </button>
                        ) : (
                          <>
                            <button
                              className={`track-pill ${track.solo ? 'is-active' : ''}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleTrackSolo(track.id);
                              }}
                              title={
                                track.kind === 'audio'
                                  ? 'Solo audio track'
                                  : track.kind === 'midi'
                                    ? 'Solo MIDI CC track output'
                                    : track.kind === 'midi-note'
                                      ? 'Solo MIDI Note track output'
                                    : track.kind === 'dmx'
                                      ? 'Solo DMX track output'
                                    : track.kind === 'dmx-color'
                                      ? 'Solo DMX Color track output'
                                    : track.kind === 'osc-color'
                                      ? 'Solo OSC Color track output'
                                    : track.kind === 'osc-array'
                                      ? 'Solo OSC Array track output'
                                    : track.kind === 'osc-3d'
                                      ? 'Solo 3D OSC track output'
                                    : track.kind === 'osc-flag'
                                      ? 'Solo OSC Flag track output'
                                    : 'Solo OSC track output'
                              }
                            >
                              S
                            </button>
                            <button
                              className={`track-pill track-pill--mute ${track.mute ? 'is-active' : ''}`}
                              onClick={(event) => {
                                event.stopPropagation();
                                toggleTrackMute(track.id);
                              }}
                              title={
                                track.kind === 'audio'
                                  ? 'Mute audio track'
                                  : track.kind === 'midi'
                                    ? 'Mute MIDI CC track output'
                                    : track.kind === 'midi-note'
                                      ? 'Mute MIDI Note track output'
                                    : track.kind === 'dmx'
                                      ? 'Mute DMX track output'
                                    : track.kind === 'dmx-color'
                                      ? 'Mute DMX Color track output'
                                    : track.kind === 'osc-color'
                                      ? 'Mute OSC Color track output'
                                    : track.kind === 'osc-array'
                                      ? 'Mute OSC Array track output'
                                    : track.kind === 'osc-3d'
                                      ? 'Mute 3D OSC track output'
                                    : track.kind === 'osc-flag'
                                      ? 'Mute OSC Flag track output'
                                    : 'Mute OSC track output'
                              }
                            >
                              M
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </div>
              <div
                ref={trackLanesPanelRef}
                className="timeline__lanes timeline__lanes--panel"
                onPointerDownCapture={handleTrackLanesMarqueeStart}
              >
                {visibleTracks.map((track) => {
                  const isGroupedChild = Boolean(groupHostByTrackId.get(track.id) && track.kind !== 'group');
                  return (
                    <TrackLane
                      key={track.id}
                        track={track}
                        groupMembers={track.kind === 'group' ? (groupMembersById.get(track.id) || EMPTY_LIST) : undefined}
                        isGroupedChild={isGroupedChild}
                        view={project.view}
                        height={getRenderedTrackHeight(track)}
                        timelineWidth={timelineWidth}
                        curveFps={project.timebase?.fps}
                        suspendRendering={isUiResizing}
                        cues={cueList}
                        isSelected={track.id === selectedTrackId}
                        externalSelectedNodeIds={selectedNodeIdsByTrack[track.id] || EMPTY_LIST}
                        onSelect={(id) => dispatch({ type: 'select-track', id })}
                        onSelectTrack={(id) => dispatch({ type: 'select-track', id })}
                        onNodeDrag={handleNodeDrag}
                        onSetNodeCurve={handleSetNodeCurve}
                        onAddNode={handleAddNode}
                        onEditNode={handleEditNode}
                        onDeleteNodes={handleDeleteNodes}
                        onSelectionChange={handleNodeSelectionChange}
                        onMoveAudioClip={handleAudioClipMove}
                        onEditAudioClipStart={handleEditAudioClipStart}
                        audioWaveform={audioWaveforms[track.id]}
                    />
                  );
                })}
                {trackEditMarquee && (
                  <div
                    className="timeline-track-marquee"
                    style={{
                      left: `${Math.min(trackEditMarquee.x1, trackEditMarquee.x2)}px`,
                      top: `${Math.min(trackEditMarquee.y1, trackEditMarquee.y2)}px`,
                      width: `${Math.max(Math.abs(trackEditMarquee.x2 - trackEditMarquee.x1), 1)}px`,
                      height: `${Math.max(Math.abs(trackEditMarquee.y2 - trackEditMarquee.y1), 1)}px`,
                    }}
                  />
                )}
                <div
                  className={`playhead-line ${isPlaying ? 'is-active' : ''}`}
                  style={{ left: `${playheadX}px` }}
                />
              </div>
            </div>
          </div>

          <div className="zoom-footer">
            <div className="zoom-footer__help">
              <button className="btn btn--ghost" onClick={() => setIsHelpOpen(true)}>
                Help
              </button>
            </div>
            <div className="zoom-footer__group">
              <span className="timeline-controls__label">Zoom W</span>
              <div className="timeline-controls__buttons">
                <button
                  className="btn btn--unit"
                  onClick={() => zoomTime(1)}
                >
                  +
                </button>
                <button
                  className="btn btn--unit"
                  onClick={() => zoomTime(-1)}
                >
                  -
                </button>
              </div>
            </div>
            <div className="zoom-footer__group">
              <span className="timeline-controls__label">Zoom H</span>
              <div className="timeline-controls__buttons">
                <button className="btn btn--unit" onClick={() => zoomTrackHeight(12)}>+</button>
                <button className="btn btn--unit" onClick={() => zoomTrackHeight(-12)}>-</button>
              </div>
            </div>
          </div>
        </div>

        {isInspectorVisible && (
          <InspectorPanel
            key={selectedTrack ? `${selectedTrack.id}-${selectedTrack.kind}` : 'inspector-empty'}
            track={selectedTrack}
            selectedNode={selectedInspectorNode}
            nameFocusToken={nameFocusToken}
            midiOutputOptions={midiOutputOptions}
            oscOutputOptions={oscOutputOptions}
            virtualMidiOutputId={VIRTUAL_MIDI_OUTPUT_ID}
            virtualMidiOutputName={VIRTUAL_MIDI_OUTPUT_NAME}
            groupMemberCount={
              selectedTrack?.kind === 'group'
                ? (groupMembersById.get(selectedTrack.id) || []).length
                : 0
            }
            onPatch={handlePatchTrack}
            onPatchNode={(nodeId, patch) => {
              if (!selectedTrack || !nodeId) return;
              handlePatchSingleNode(selectedTrack.id, nodeId, patch);
            }}
            onOpenAudioChannelMap={openAudioChannelMapDialog}
            onOpenOsc3dMonitor={openOsc3dMonitor}
            onNameEnterNext={handleNameEnterNext}
            onAudioFile={(file) => {
              if (!selectedTrack) return;
              handleAudioFile(selectedTrack.id, file);
            }}
            onAddNode={() => {
              if (!selectedTrack) return;
              if (selectedTrack.kind === 'group') return;
              const t = clamp(playhead, 0, project.view.length);
              if (selectedTrack.kind === 'osc-flag') {
                handleAddNode(selectedTrack.id, { t, v: 1, d: 1, y: 0.5, curve: 'linear' });
                return;
              }
              if (selectedTrack.kind === 'osc-array') {
                const arr = sampleOscArrayTrackValues(selectedTrack, t, project.timebase?.fps);
                handleAddNode(selectedTrack.id, { t, v: arr[0] ?? selectedTrack.default ?? 0, arr, curve: 'linear' });
                return;
              }
              if (selectedTrack.kind === 'osc-3d') {
                const arr = sampleOsc3dTrackValues(selectedTrack, t, project.timebase?.fps);
                handleAddNode(selectedTrack.id, { t, v: arr[1] ?? selectedTrack.default ?? 0, arr, curve: 'linear' });
                return;
              }
              if (selectedTrack.kind === 'midi-note') {
                handleAddNode(selectedTrack.id, { t, v: 60, d: 0.5, curve: 'linear' });
                return;
              }
              const v = sampleTrackValue(selectedTrack, t);
              handleAddNode(selectedTrack.id, { t, v, curve: 'linear' });
            }}
          />
        )}
      </div>
    </div>
  );
}
