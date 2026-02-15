const deepClone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const AUDIO_BUFFER_SIZES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const HISTORY_LIMIT = 200;
const AUDIO_TRACK_MAX_CHANNELS = 64;
const DEFAULT_PROJECT_LENGTH_SECONDS = 600;
const DEFAULT_VIEW_SPAN_SECONDS = 8;
const MIN_LOOP_SPAN_SECONDS = 0.001;
const DEFAULT_OSC_OUTPUT_ID = 'osc-out-main';
const OSC_TRACK_KINDS = new Set(['osc', 'osc-array', 'osc-color', 'osc-flag', 'osc-3d']);
const HISTORY_ACTIONS = new Set([
  'update-project',
  'add-composition',
  'delete-composition',
  'move-composition',
  'switch-composition',
  'update-composition',
  'add-track',
  'add-tracks',
  'paste-tracks',
  'move-track',
  'move-tracks',
  'update-track',
  'update-tracks-color',
  'delete-track',
  'delete-tracks',
  'load-project',
  'add-node',
  'add-nodes',
  'delete-nodes',
  'update-node',
  'add-cue',
  'update-cue',
  'delete-cue',
]);
const DEFAULT_OSC_SETTINGS = {
  host: '127.0.0.1',
  port: 9000,
  outputs: [
    {
      id: DEFAULT_OSC_OUTPUT_ID,
      name: 'Main',
      host: '127.0.0.1',
      port: 9000,
    },
  ],
  listenPort: 8999,
  controlPort: 8998,
};
const DEFAULT_AUDIO_SETTINGS = {
  outputDeviceId: 'default',
  sampleRate: 48000,
  bufferSize: 1024,
  ltc: {
    inputDeviceId: 'default',
    channel: 1,
  },
};
const SYNC_FPS_IDS = ['23.98', '24', '25', '29.97', '29.97drop', '30', '30drop'];
const DEFAULT_SYNC_FPS_ID = '30';
const DEFAULT_MIDI_SETTINGS = {
  inputId: 'virtual-midi-in',
  outputId: 'virtual-midi-out',
};
const DEFAULT_MIDI_TRACK_SETTINGS = {
  outputId: DEFAULT_MIDI_SETTINGS.outputId,
  channel: 1,
  controlNumber: 1,
  mode: 'cc',
};
const DEFAULT_MIDI_NOTE_TRACK_SETTINGS = {
  outputId: DEFAULT_MIDI_SETTINGS.outputId,
  channel: 1,
  mode: 'note',
  note: 60,
  velocity: 100,
};
const DEFAULT_DMX_TRACK_SETTINGS = {
  host: '127.0.0.1',
  universe: 0,
  channel: 1,
};
const DEFAULT_AUDIO_TRACK_SETTINGS = {
  src: '',
  nativePath: '',
  name: '',
  duration: 0,
  clipStart: 0,
  volume: 1,
  outputDeviceId: 'project-default',
  channels: 2,
  channelMapEnabled: false,
  channelMap: [1, 2],
};
const DEFAULT_DMX_COLOR_TRACK_SETTINGS = {
  host: '127.0.0.1',
  universe: 0,
  channelStart: 1,
  fixtureType: 'rgb',
  mappingChannels: 4,
  gradientFrom: '#000000',
  gradientTo: '#000000',
  mapping: {
    r: 1,
    g: 2,
    b: 3,
    w: 4,
  },
};
const DEFAULT_OSC_COLOR_TRACK_SETTINGS = {
  fixtureType: 'rgb',
  outputRange: 'byte',
  gradientFrom: '#000000',
  gradientTo: '#000000',
};
const DEFAULT_OSC_ARRAY_TRACK_SETTINGS = {
  valueCount: 5,
};
const DEFAULT_OSC_3D_TRACK_SETTINGS = {
  bounds: {
    xMin: -1,
    xMax: 1,
    yMin: -1,
    yMax: 1,
    zMin: -1,
    zMax: 1,
  },
};
const TRACK_COLORS = [
  '#5dd8c7',
  '#ffb458',
  '#66a3ff',
  '#f472b6',
  '#34d399',
  '#a78bfa',
  '#f87171',
  '#22d3ee',
  '#facc15',
  '#94a3b8',
];

const normalizeTrackColor = (value, fallback = '#5dd8c7') => {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  const match = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (match) return `#${match[1].toLowerCase()}`;
  return fallback;
};

const pickTrackColor = (index) => {
  const safeIndex = Math.max(Number(index) || 1, 1);
  return TRACK_COLORS[(safeIndex - 1) % TRACK_COLORS.length];
};

const toFinite = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

const nearestBufferSize = (value) => {
  if (AUDIO_BUFFER_SIZES.includes(value)) return value;
  return AUDIO_BUFFER_SIZES.reduce((nearest, option) => (
    Math.abs(option - value) < Math.abs(nearest - value) ? option : nearest
  ), DEFAULT_AUDIO_SETTINGS.bufferSize);
};

const normalizeRange = (min, max) => {
  if (min <= max) return { min, max };
  return { min: max, max: min };
};

const normalizePort = (value, fallback) => {
  const next = Math.round(toFinite(value, fallback));
  return clamp(next, 1, 65535);
};

const createOscOutputId = () => `osc-out-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

const normalizeOscOutput = (output, fallback, index) => {
  const source = output || {};
  const nameFallback = `Output ${String(index + 1).padStart(2, '0')}`;
  return {
    id: typeof source.id === 'string' && source.id.trim()
      ? source.id.trim()
      : createOscOutputId(),
    name: typeof source.name === 'string' && source.name.trim()
      ? source.name.trim()
      : nameFallback,
    host:
      typeof source.host === 'string' && source.host.trim()
        ? source.host.trim()
        : fallback.host,
    port: normalizePort(source.port, fallback.port),
  };
};

const normalizeOscOutputs = (outputs, fallback) => {
  const raw = Array.isArray(outputs) ? outputs : [];
  const normalized = raw.map((output, index) => normalizeOscOutput(output, fallback, index));
  const unique = [];
  const ids = new Set();
  normalized.forEach((output, index) => {
    const safeOutput = { ...output };
    if (!safeOutput.id || ids.has(safeOutput.id)) {
      safeOutput.id = index === 0 ? DEFAULT_OSC_OUTPUT_ID : createOscOutputId();
    }
    ids.add(safeOutput.id);
    unique.push(safeOutput);
  });
  if (unique.length) return unique;
  return [{
    id: DEFAULT_OSC_OUTPUT_ID,
    name: 'Main',
    host: fallback.host,
    port: normalizePort(fallback.port, DEFAULT_OSC_SETTINGS.port),
  }];
};

const normalizeOscAddress = (address, fallback = '/osc/input') => {
  if (typeof address !== 'string') return fallback;
  const trimmed = address.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
};

const normalizeOscValueType = (value) => (
  value === 'int' ? 'int' : 'float'
);

const VALID_CURVE_MODES = new Set([
  'none',
  'linear',
  'quad-in',
  'quad-out',
  'quad-in-out',
  'cubic-in',
  'cubic-out',
  'cubic-in-out',
  'quart-in',
  'quart-out',
  'quart-in-out',
  'quint-in',
  'quint-out',
  'quint-in-out',
  'sine-in',
  'sine-out',
  'sine-in-out',
  'circ-in',
  'circ-out',
  'circ-in-out',
  'expo-in',
  'expo-out',
  'expo-in-out',
  'elastic-in',
  'elastic-out',
  'elastic-in-out',
  'back-in',
  'back-out',
  'back-in-out',
  'bounce-in',
  'bounce-out',
  'bounce-in-out',
  'smooth',
]);

const normalizeCurveMode = (value) => {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!raw) return 'linear';
  if (VALID_CURVE_MODES.has(raw)) return raw;
  if (raw === 'step' || raw === 'no-interpolation' || raw === 'nointerpolation') return 'none';
  if (raw === 'ease-in') return 'cubic-in';
  if (raw === 'ease-out') return 'cubic-out';
  if (raw === 'ease-in-out') return 'cubic-in-out';
  return 'linear';
};

const isOscTrackKind = (kind) => OSC_TRACK_KINDS.has(kind);

const normalizeDmxFixtureType = (value) => (
  value === 'rgb' || value === 'rgbw' || value === 'mapping' ? value : 'rgb'
);

const normalizeOscColorFixtureType = (value) => (
  value === 'rgbw' ? 'rgbw' : 'rgb'
);

const normalizeOscColorOutputRange = (value) => (
  value === 'unit' ? 'unit' : 'byte'
);

const normalizeOscArrayValueCount = (value) => (
  clamp(Math.round(toFinite(value, DEFAULT_OSC_ARRAY_TRACK_SETTINGS.valueCount)), 1, 20)
);

const normalizeOscArrayValues = (value, count, fallback, min, max) => {
  const safeCount = normalizeOscArrayValueCount(count);
  const raw = Array.isArray(value) ? value : [];
  const safeFallback = clamp(toFinite(fallback, min), min, max);
  return Array.from({ length: safeCount }, (_, index) => (
    clamp(toFinite(raw[index], safeFallback), min, max)
  ));
};

const normalizeOsc3dAxisBounds = (rawMin, rawMax, fallbackMin, fallbackMax) => {
  const min = toFinite(rawMin, fallbackMin);
  const max = toFinite(rawMax, fallbackMax);
  if (min <= max) return { min, max };
  return { min: max, max: min };
};

const normalizeOsc3dSettings = (value) => {
  const source = value || {};
  const bounds = source.bounds || {};
  const xBounds = normalizeOsc3dAxisBounds(
    bounds.xMin,
    bounds.xMax,
    DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.xMin,
    DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.xMax
  );
  const yBounds = normalizeOsc3dAxisBounds(
    bounds.yMin,
    bounds.yMax,
    DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.yMin,
    DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.yMax
  );
  const zBounds = normalizeOsc3dAxisBounds(
    bounds.zMin,
    bounds.zMax,
    DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.zMin,
    DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.zMax
  );
  return {
    bounds: {
      xMin: xBounds.min,
      xMax: xBounds.max,
      yMin: yBounds.min,
      yMax: yBounds.max,
      zMin: zBounds.min,
      zMax: zBounds.max,
    },
  };
};

const normalizeMappingChannels = (value) => {
  const channels = Math.round(toFinite(value, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mappingChannels));
  return channels === 3 ? 3 : 4;
};

const normalizeAudioChannels = (value, fallback = DEFAULT_AUDIO_TRACK_SETTINGS.channels) => (
  clamp(Math.round(toFinite(value, fallback)), 1, AUDIO_TRACK_MAX_CHANNELS)
);

const normalizeAudioChannelMap = (value, channels) => {
  const safeChannels = normalizeAudioChannels(channels, channels);
  const raw = Array.isArray(value) ? value : [];
  return Array.from({ length: safeChannels }, (_, index) => {
    const fallback = index + 1;
    const next = Math.round(toFinite(raw[index], fallback));
    return clamp(next, 1, AUDIO_TRACK_MAX_CHANNELS);
  });
};

const normalizeMidiCcValue = (value, fallback = 0) => (
  clamp(Math.round(toFinite(value, fallback)), 0, 127)
);

const normalizeDmxValue = (value, fallback = 0) => (
  clamp(Math.round(toFinite(value, fallback)), 0, 255)
);

const buildAutoTrackName = (address, index) => {
  const parts = address.split('/').filter(Boolean);
  const tail = parts[parts.length - 1];
  if (tail) return `OSC ${tail}`;
  return `OSC ${String(index).padStart(2, '0')}`;
};

const normalizeTrack = (track, fallbackColor = '#5dd8c7') => {
  const rawMin = toFinite(track.min, 0);
  const rawMax = toFinite(track.max, 1);
  const { min, max } = normalizeRange(rawMin, rawMax);
  const next = {
    ...track,
    name: typeof track.name === 'string' ? track.name : '',
    oscAddress: typeof track.oscAddress === 'string' ? track.oscAddress : '',
    groupId: typeof track.groupId === 'string' ? track.groupId : null,
    color: normalizeTrackColor(track.color, fallbackColor),
    mute: Boolean(track.mute),
    solo: Boolean(track.solo),
    min,
    max,
  };
  if (!next.kind) next.kind = 'osc';
  if (next.kind === 'midi' && track?.midi?.mode === 'note') {
    next.kind = 'midi-note';
  }
  if (!next.id) next.id = `track-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  if (next.kind === 'group') {
    next.groupId = '';
    next.group = {
      expanded: track?.group?.expanded !== false,
    };
    next.min = 0;
    next.max = 1;
    next.default = 0;
    next.oscAddress = '';
  }

  next.oscOutputId = isOscTrackKind(next.kind)
    ? (
      typeof track.oscOutputId === 'string' && track.oscOutputId.trim()
        ? track.oscOutputId.trim()
        : DEFAULT_OSC_OUTPUT_ID
    )
    : '';

  if (next.kind === 'midi' || next.kind === 'midi-note') {
    const midi = track.midi || {};
    if (next.kind === 'midi-note') {
      next.midi = {
        outputId:
          typeof midi.outputId === 'string' && midi.outputId
            ? midi.outputId
            : DEFAULT_MIDI_NOTE_TRACK_SETTINGS.outputId,
        channel: clamp(Math.round(toFinite(midi.channel, DEFAULT_MIDI_NOTE_TRACK_SETTINGS.channel)), 1, 16),
        mode: 'note',
        note: clamp(Math.round(toFinite(midi.note, DEFAULT_MIDI_NOTE_TRACK_SETTINGS.note)), 0, 127),
        velocity: clamp(Math.round(toFinite(midi.velocity, DEFAULT_MIDI_NOTE_TRACK_SETTINGS.velocity)), 0, 127),
      };
      next.min = 0;
      next.max = 127;
      next.default = clamp(Math.round(toFinite(next.default, 60)), 0, 127);
    } else {
      next.midi = {
        outputId:
          typeof midi.outputId === 'string' && midi.outputId
            ? midi.outputId
            : DEFAULT_MIDI_TRACK_SETTINGS.outputId,
        channel: clamp(Math.round(toFinite(midi.channel, DEFAULT_MIDI_TRACK_SETTINGS.channel)), 1, 16),
        mode: 'cc',
        controlNumber: clamp(
          Math.round(toFinite(midi.controlNumber, DEFAULT_MIDI_TRACK_SETTINGS.controlNumber)),
          0,
          127
        ),
      };
      next.min = 0;
      next.max = 127;
      next.default = normalizeMidiCcValue(next.default, 0);
    }
  }

  if (next.kind === 'dmx') {
    const dmx = track.dmx || {};
    next.dmx = {
      host: typeof dmx.host === 'string' && dmx.host.trim() ? dmx.host.trim() : DEFAULT_DMX_TRACK_SETTINGS.host,
      universe: clamp(Math.round(toFinite(dmx.universe, DEFAULT_DMX_TRACK_SETTINGS.universe)), 0, 32767),
      channel: clamp(Math.round(toFinite(dmx.channel, DEFAULT_DMX_TRACK_SETTINGS.channel)), 1, 512),
    };
    next.min = 0;
    next.max = 255;
  }

  if (next.kind === 'dmx-color') {
    const dmxColor = track.dmxColor || {};
    const mapping = dmxColor.mapping || {};
    next.dmxColor = {
      host:
        typeof dmxColor.host === 'string' && dmxColor.host.trim()
          ? dmxColor.host.trim()
          : DEFAULT_DMX_COLOR_TRACK_SETTINGS.host,
      universe: clamp(
        Math.round(toFinite(dmxColor.universe, DEFAULT_DMX_COLOR_TRACK_SETTINGS.universe)),
        0,
        32767
      ),
      channelStart: clamp(
        Math.round(toFinite(dmxColor.channelStart, DEFAULT_DMX_COLOR_TRACK_SETTINGS.channelStart)),
        1,
        512
      ),
      fixtureType: normalizeDmxFixtureType(dmxColor.fixtureType),
      mappingChannels: normalizeMappingChannels(dmxColor.mappingChannels),
      gradientFrom: normalizeTrackColor(
        dmxColor.gradientFrom,
        DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientFrom
      ),
      gradientTo: normalizeTrackColor(
        dmxColor.gradientTo,
        DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientTo
      ),
      mapping: {
        r: clamp(Math.round(toFinite(mapping.r, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.r)), 1, 512),
        g: clamp(Math.round(toFinite(mapping.g, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.g)), 1, 512),
        b: clamp(Math.round(toFinite(mapping.b, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.b)), 1, 512),
        w: clamp(Math.round(toFinite(mapping.w, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.w)), 1, 512),
      },
    };
    next.min = 0;
    next.max = 255;
  }

  if (next.kind === 'osc-color') {
    const oscColor = track.oscColor || {};
    next.oscColor = {
      fixtureType: normalizeOscColorFixtureType(oscColor.fixtureType),
      outputRange: normalizeOscColorOutputRange(oscColor.outputRange),
      gradientFrom: normalizeTrackColor(
        oscColor.gradientFrom,
        DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientFrom
      ),
      gradientTo: normalizeTrackColor(
        oscColor.gradientTo,
        DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientTo
      ),
    };
    next.min = 0;
    next.max = 255;
    next.oscAddress = normalizeOscAddress(next.oscAddress, '/osc/color');
  }

  if (next.kind === 'osc' || next.kind === 'osc-array' || next.kind === 'osc-flag' || next.kind === 'osc-3d') {
    next.oscValueType = normalizeOscValueType(next.oscValueType);
  } else {
    next.oscValueType = '';
  }

  if (next.kind === 'osc-array') {
    const oscArray = track.oscArray || {};
    next.oscArray = {
      valueCount: normalizeOscArrayValueCount(oscArray.valueCount),
    };
    next.oscAddress = normalizeOscAddress(next.oscAddress, '/osc/array');
  }

  if (next.kind === 'osc-3d') {
    next.osc3d = normalizeOsc3dSettings(track.osc3d);
    next.oscAddress = normalizeOscAddress(next.oscAddress, '/osc/3d');
    next.min = next.osc3d.bounds.yMin;
    next.max = next.osc3d.bounds.yMax;
  }

  if (next.kind === 'osc-flag') {
    next.oscAddress = normalizeOscAddress(next.oscAddress, '/osc/flag');
  }

  if (
    next.kind !== 'osc'
    && next.kind !== 'osc-flag'
    && next.kind !== 'osc-color'
    && next.kind !== 'osc-array'
    && next.kind !== 'osc-3d'
  ) {
    next.oscAddress = '';
  }

  if (next.kind === 'midi') {
    next.default = normalizeMidiCcValue(next.default, 0);
  } else if (next.kind === 'midi-note') {
    next.default = clamp(Math.round(toFinite(next.default, 60)), 0, 127);
  } else if (next.kind === 'dmx' || next.kind === 'dmx-color') {
    next.default = normalizeDmxValue(next.default, 0);
  } else {
    next.default = clamp(toFinite(next.default, next.min), next.min, next.max);
  }
  next.nodes = next.kind === 'group'
    ? []
    : (track.nodes || [])
    .map((node) => {
      const normalized = {
        id: node.id ?? createNodeId(),
        ...node,
        t: Math.max(toFinite(node.t, 0), 0),
        v: next.kind === 'osc-flag'
          ? toFinite(node.v, 1)
          : clamp(toFinite(node.v, next.default), next.min, next.max),
        curve: normalizeCurveMode(node.curve),
      };
      if (next.kind === 'osc-flag') {
        normalized.a = normalizeOscAddress(
          node?.a,
          normalizeOscAddress(next.oscAddress, '/osc/flag')
        );
        normalized.d = Math.max(toFinite(node?.d, 1), 0);
        normalized.y = clamp(toFinite(node?.y, 0.5), 0, 1);
      }
      if (next.kind === 'dmx-color') {
        normalized.c = normalizeTrackColor(
          node.c,
          next.dmxColor?.gradientFrom || DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientFrom
        );
      }
      if (next.kind === 'osc-color') {
        normalized.c = normalizeTrackColor(
          node.c,
          next.oscColor?.gradientFrom || DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientFrom
        );
      }
      if (next.kind === 'osc-array') {
        const count = normalizeOscArrayValueCount(next.oscArray?.valueCount);
        normalized.arr = normalizeOscArrayValues(
          node.arr,
          count,
          normalized.v,
          next.min,
          next.max
        );
        normalized.v = normalized.arr[0] ?? normalized.v;
      }
      if (next.kind === 'osc-3d') {
        const bounds = normalizeOsc3dSettings(next.osc3d).bounds;
        const fallbackX = (bounds.xMin + bounds.xMax) * 0.5;
        const fallbackY = clamp(toFinite(node?.v, next.default), bounds.yMin, bounds.yMax);
        const fallbackZ = (bounds.zMin + bounds.zMax) * 0.5;
        const raw = Array.isArray(node?.arr) ? node.arr : [];
        const x = clamp(toFinite(raw[0], fallbackX), bounds.xMin, bounds.xMax);
        const y = clamp(toFinite(raw[1], fallbackY), bounds.yMin, bounds.yMax);
        const z = clamp(toFinite(raw[2], fallbackZ), bounds.zMin, bounds.zMax);
        normalized.arr = [x, y, z];
        normalized.v = y;
      }
      if (next.kind === 'midi-note') {
        normalized.v = clamp(Math.round(toFinite(node?.v, next.default)), 0, 127);
        normalized.d = Math.max(toFinite(node?.d, 0.5), 0.01);
      }
      if (next.kind === 'midi') {
        normalized.v = normalizeMidiCcValue(node?.v, next.default);
      }
      if (next.kind === 'dmx' || next.kind === 'dmx-color') {
        normalized.v = normalizeDmxValue(node?.v, next.default);
      }
      return normalized;
    })
    .sort((a, b) => a.t - b.t);
  if (next.kind === 'audio') {
    const audioSrc = typeof next.audio?.src === 'string' ? next.audio.src : '';
    const audioNativePath = typeof next.audio?.nativePath === 'string' ? next.audio.nativePath : '';
    const channels = normalizeAudioChannels(next.audio?.channels);
    next.audio = {
      ...DEFAULT_AUDIO_TRACK_SETTINGS,
      ...(next.audio || {}),
      src: audioSrc.startsWith('file://') ? '' : audioSrc,
      nativePath: audioNativePath,
      duration: Math.max(toFinite(next.audio?.duration, 0), 0),
      clipStart: Math.max(toFinite(next.audio?.clipStart, 0), 0),
      volume: clamp(toFinite(next.audio?.volume, 1), 0, 1),
      outputDeviceId:
        typeof next.audio?.outputDeviceId === 'string' && next.audio.outputDeviceId
          ? next.audio.outputDeviceId
          : DEFAULT_AUDIO_TRACK_SETTINGS.outputDeviceId,
      channels,
      channelMapEnabled: Boolean(next.audio?.channelMapEnabled),
      channelMap: normalizeAudioChannelMap(next.audio?.channelMap, channels),
    };
  }
  return next;
};

const createNodeId = () => `node-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const createCueId = () => `cue-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const createCompositionId = () => `composition-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

const normalizeView = (view) => {
  const length = Math.max(toFinite(view.length, DEFAULT_PROJECT_LENGTH_SECONDS), 1);
  const startRaw = Math.max(toFinite(view.start, 0), 0);
  const endRaw = Math.max(toFinite(view.end, startRaw + 1), startRaw + 1);
  const span = Math.max(endRaw - startRaw, 1);
  const safeSpan = Math.min(span, length);
  let start = clamp(startRaw, 0, Math.max(length - safeSpan, 0));
  let end = start + safeSpan;
  if (end > length) {
    end = length;
    start = Math.max(end - safeSpan, 0);
  }
  let loopStart = clamp(toFinite(view.loopStart, start), 0, length);
  let loopEnd = clamp(toFinite(view.loopEnd, end), 0, length);
  if (loopEnd - loopStart < MIN_LOOP_SPAN_SECONDS) {
    loopEnd = clamp(loopStart + MIN_LOOP_SPAN_SECONDS, 0, length);
    if (loopEnd - loopStart < MIN_LOOP_SPAN_SECONDS) {
      loopStart = clamp(loopEnd - MIN_LOOP_SPAN_SECONDS, 0, length);
    }
  }
  return {
    ...view,
    trackHeight: clamp(toFinite(view.trackHeight, 96), 64, 640),
    length,
    start,
    end,
    loopEnabled: Boolean(view.loopEnabled),
    loopStart,
    loopEnd,
  };
};

const normalizeCues = (cues, length) => (Array.isArray(cues) ? cues : [])
  .map((cue) => ({
    id: cue.id ?? createCueId(),
    t: clamp(cue.t ?? 0, 0, length),
  }))
  .sort((a, b) => a.t - b.t);

const normalizeTracks = (tracks, oscOutputIds = new Set([DEFAULT_OSC_OUTPUT_ID]), fallbackOscOutputId = DEFAULT_OSC_OUTPUT_ID) => {
  const safeOutputIds = oscOutputIds instanceof Set ? oscOutputIds : new Set([fallbackOscOutputId]);
  const safeFallback = safeOutputIds.has(fallbackOscOutputId)
    ? fallbackOscOutputId
    : (safeOutputIds.values().next().value || DEFAULT_OSC_OUTPUT_ID);
  const normalizedTracks = (Array.isArray(tracks) ? tracks : [])
    .map((track, index) => {
      const normalized = normalizeTrack(track, pickTrackColor(index + 1));
      if (isOscTrackKind(normalized.kind)) {
        const currentOutputId =
          typeof normalized.oscOutputId === 'string' && normalized.oscOutputId
            ? normalized.oscOutputId
            : safeFallback;
        normalized.oscOutputId = safeOutputIds.has(currentOutputId) ? currentOutputId : safeFallback;
      } else {
        normalized.oscOutputId = '';
      }
      return normalized;
    });
  const groupIds = new Set(
    normalizedTracks
      .filter((track) => track.kind === 'group')
      .map((track) => track.id)
  );
  normalizedTracks.forEach((track) => {
    if (track.kind === 'group') {
      track.groupId = '';
      return;
    }
    if (track.groupId === null) return;
    if (!track.groupId || !groupIds.has(track.groupId) || track.groupId === track.id) {
      track.groupId = '';
    }
  });
  return normalizedTracks;
};

const normalizeComposition = (
  composition,
  index,
  fallbackView,
  oscOutputIds = new Set([DEFAULT_OSC_OUTPUT_ID]),
  fallbackOscOutputId = DEFAULT_OSC_OUTPUT_ID
) => {
  const view = normalizeView(composition?.view || fallbackView);
  return {
    id:
      typeof composition?.id === 'string' && composition.id.trim()
        ? composition.id
        : createCompositionId(),
    name:
      typeof composition?.name === 'string' && composition.name.trim()
        ? composition.name.trim()
        : `Composition ${String(index).padStart(2, '0')}`,
    view,
    cues: normalizeCues(composition?.cues, view.length),
    tracks: normalizeTracks(composition?.tracks, oscOutputIds, fallbackOscOutputId),
  };
};

const getOscOutputsFromProject = (project) => normalizeOscOutputs(project?.osc?.outputs, {
  host:
    typeof project?.osc?.host === 'string' && project.osc.host.trim()
      ? project.osc.host.trim()
      : DEFAULT_OSC_SETTINGS.host,
  port: normalizePort(project?.osc?.port, DEFAULT_OSC_SETTINGS.port),
});

const getDefaultOscOutputIdFromProject = (project) => {
  const outputs = getOscOutputsFromProject(project);
  return outputs[0]?.id || DEFAULT_OSC_OUTPUT_ID;
};

const getOscOutputIdSetFromProject = (project) => {
  const outputs = getOscOutputsFromProject(project);
  return new Set(outputs.map((output) => output.id));
};

const syncActiveCompositionInProject = (project) => {
  const compositions = Array.isArray(project.compositions) ? project.compositions : [];
  if (!compositions.length) return project;
  const activeId =
    typeof project.activeCompositionId === 'string' && project.activeCompositionId
      ? project.activeCompositionId
      : compositions[0].id;
  const oscOutputs = getOscOutputsFromProject(project);
  const oscOutputIds = new Set(oscOutputs.map((output) => output.id));
  const defaultOscOutputId = oscOutputs[0]?.id || DEFAULT_OSC_OUTPUT_ID;
  const view = normalizeView(project.view || compositions[0].view);
  const cues = normalizeCues(project.cues, view.length);
  const tracks = normalizeTracks(project.tracks, oscOutputIds, defaultOscOutputId);
  const nextCompositions = compositions.map((composition) => (
    composition.id !== activeId
      ? composition
      : { ...composition, view, cues, tracks }
  ));
  return {
    ...project,
    activeCompositionId: activeId,
    view,
    cues,
    tracks,
    compositions: nextCompositions,
  };
};

const normalizeProject = (project) => {
  const fallbackView = normalizeView(project.view || {
    start: 0,
    end: DEFAULT_VIEW_SPAN_SECONDS,
    length: DEFAULT_PROJECT_LENGTH_SECONDS,
    trackHeight: 96,
  });
  const fallbackCues = normalizeCues(project.cues, fallbackView.length);
  const legacyOscFallback = {
    host:
      typeof project.osc?.host === 'string' && project.osc.host.trim()
        ? project.osc.host.trim()
        : DEFAULT_OSC_SETTINGS.host,
    port: normalizePort(project.osc?.port, DEFAULT_OSC_SETTINGS.port),
  };
  const oscOutputs = normalizeOscOutputs(project.osc?.outputs, legacyOscFallback);
  const defaultOscOutput = oscOutputs[0] || {
    id: DEFAULT_OSC_OUTPUT_ID,
    host: DEFAULT_OSC_SETTINGS.host,
    port: DEFAULT_OSC_SETTINGS.port,
  };
  const oscOutputIds = new Set(oscOutputs.map((output) => output.id));
  const fallbackTracks = normalizeTracks(project.tracks, oscOutputIds, defaultOscOutput.id);
  const audio = {
    outputDeviceId:
      typeof project.audio?.outputDeviceId === 'string' && project.audio.outputDeviceId
        ? project.audio.outputDeviceId
        : DEFAULT_AUDIO_SETTINGS.outputDeviceId,
    sampleRate: clamp(toFinite(project.audio?.sampleRate, DEFAULT_AUDIO_SETTINGS.sampleRate), 8000, 192000),
    bufferSize: nearestBufferSize(toFinite(project.audio?.bufferSize, DEFAULT_AUDIO_SETTINGS.bufferSize)),
    ltc: {
      inputDeviceId:
        typeof project.audio?.ltc?.inputDeviceId === 'string' && project.audio.ltc.inputDeviceId
          ? project.audio.ltc.inputDeviceId
          : DEFAULT_AUDIO_SETTINGS.ltc.inputDeviceId,
      channel: clamp(
        Math.round(toFinite(project.audio?.ltc?.channel, DEFAULT_AUDIO_SETTINGS.ltc.channel)),
        1,
        64
      ),
    },
  };
  const osc = {
    host: defaultOscOutput.host,
    port: normalizePort(defaultOscOutput.port, DEFAULT_OSC_SETTINGS.port),
    outputs: oscOutputs,
    listenPort: normalizePort(project.osc?.listenPort, DEFAULT_OSC_SETTINGS.listenPort),
    controlPort: normalizePort(project.osc?.controlPort, DEFAULT_OSC_SETTINGS.controlPort),
  };
  const midi = {
    inputId:
      typeof project.midi?.inputId === 'string' && project.midi.inputId
        ? project.midi.inputId
        : DEFAULT_MIDI_SETTINGS.inputId,
    outputId:
      typeof project.midi?.outputId === 'string' && project.midi.outputId
        ? project.midi.outputId
        : DEFAULT_MIDI_SETTINGS.outputId,
  };
  const sourceCompositions = Array.isArray(project.compositions) && project.compositions.length
    ? project.compositions
    : [{
      id:
        typeof project.activeCompositionId === 'string' && project.activeCompositionId
          ? project.activeCompositionId
          : createCompositionId(),
      name: 'Composition 01',
      view: fallbackView,
      cues: fallbackCues,
      tracks: fallbackTracks,
    }];
  const compositions = sourceCompositions
    .map((composition, index) => normalizeComposition(
      composition,
      index + 1,
      fallbackView,
      oscOutputIds,
      defaultOscOutput.id
    ));
  const activeCompositionId =
    typeof project.activeCompositionId === 'string'
    && compositions.some((composition) => composition.id === project.activeCompositionId)
      ? project.activeCompositionId
      : compositions[0].id;
  const activeComposition = compositions.find((composition) => composition.id === activeCompositionId)
    || compositions[0];

  return {
    ...project,
    view: activeComposition.view,
    osc,
    audio,
    midi,
    activeCompositionId,
    compositions,
    timebase: {
      ...(project.timebase || {}),
      bpm: toFinite(project.timebase?.bpm, 120),
      fps: clamp(toFinite(project.timebase?.fps, 30), 1, 240),
      timeSignature: Array.isArray(project.timebase?.timeSignature) ? project.timebase.timeSignature : [4, 4],
      unit: project.timebase?.unit || 'seconds',
      sync: project.timebase?.sync || 'Internal',
      syncFps: SYNC_FPS_IDS.includes(project.timebase?.syncFps)
        ? project.timebase.syncFps
        : DEFAULT_SYNC_FPS_ID,
    },
    cues: activeComposition.cues,
    tracks: activeComposition.tracks,
  };
};

const createTrack = (index, view, kind = 'osc', options = {}) => {
  const id = `track-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
  const name =
    kind === 'audio'
      ? `Audio ${String(index).padStart(2, '0')}`
      : kind === 'group'
        ? `Group ${String(index).padStart(2, '0')}`
      : kind === 'midi'
        ? `MIDI CC ${String(index).padStart(2, '0')}`
      : kind === 'midi-note'
        ? `MIDI Note ${String(index).padStart(2, '0')}`
      : kind === 'osc-array'
        ? `OSC Array ${String(index).padStart(2, '0')}`
      : kind === 'osc-3d'
        ? `3D OSC ${String(index).padStart(2, '0')}`
      : kind === 'osc-color'
          ? `OSC Color ${String(index).padStart(2, '0')}`
        : kind === 'osc-flag'
          ? `OSC Flag ${String(index).padStart(2, '0')}`
        : kind === 'dmx-color'
          ? `DMX Color ${String(index).padStart(2, '0')}`
        : kind === 'dmx'
          ? `DMX ${String(index).padStart(2, '0')}`
        : `Track ${String(index).padStart(2, '0')}`;
  const min = kind === 'osc-3d'
    ? DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.yMin
    : (kind === 'midi' || kind === 'midi-note' || kind === 'dmx' || kind === 'dmx-color' || kind === 'osc-color'
      ? 0
      : 0);
  const max = kind === 'midi' || kind === 'midi-note'
    ? 127
    : (kind === 'osc-3d'
      ? DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.yMax
      : ((kind === 'dmx' || kind === 'dmx-color' || kind === 'osc-color') ? 255 : 1));
  const def = kind === 'audio'
    ? 1
    : (
      kind === 'group'
        ? 0
        : (
      kind === 'midi' || kind === 'dmx' || kind === 'dmx-color' || kind === 'osc-color'
        ? 0
        : (
          kind === 'midi-note'
            ? 60
            : (
              kind === 'osc-flag'
                ? 1
                : (kind === 'osc-array'
                  ? 0
                  : (kind === 'osc-3d'
                    ? (DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.yMin + DEFAULT_OSC_3D_TRACK_SETTINGS.bounds.yMax) * 0.5
                    : 0.5))
            )
        )
        )
    );
  const base = {
    id,
    name,
    kind,
    groupId: '',
    color: pickTrackColor(index),
    mute: false,
    solo: false,
    min,
    max,
    default: def,
    oscOutputId: isOscTrackKind(kind)
      ? (
        typeof options.oscOutputId === 'string' && options.oscOutputId.trim()
          ? options.oscOutputId.trim()
          : DEFAULT_OSC_OUTPUT_ID
      )
      : '',
    oscValueType: kind === 'osc' || kind === 'osc-array' || kind === 'osc-flag' || kind === 'osc-3d' ? 'float' : '',
    oscAddress:
      kind === 'osc'
        ? `/track/${index}/value`
        : (kind === 'osc-array'
          ? `/track/${index}/send`
          : (kind === 'osc-3d'
            ? `/track/${index}/xyz`
            : (kind === 'osc-color'
              ? `/track/${index}/color`
              : (kind === 'osc-flag' ? `/track/${index}/flag` : '')))),
    nodes: [],
  };
  if (kind === 'audio') {
    return {
      ...base,
      audio: {
        ...DEFAULT_AUDIO_TRACK_SETTINGS,
      },
    };
  }
  if (kind === 'group') {
    return {
      ...base,
      group: {
        expanded: true,
      },
      nodes: [],
    };
  }
  if (kind === 'midi') {
    const midiOptions = options.midi || {};
    return {
      ...base,
      midi: {
        ...DEFAULT_MIDI_TRACK_SETTINGS,
        outputId:
          typeof midiOptions.outputId === 'string' && midiOptions.outputId
            ? midiOptions.outputId
            : DEFAULT_MIDI_TRACK_SETTINGS.outputId,
        channel: clamp(
          Math.round(toFinite(midiOptions.channel, DEFAULT_MIDI_TRACK_SETTINGS.channel)),
          1,
          16
        ),
        mode: 'cc',
        controlNumber: clamp(
          Math.round(toFinite(midiOptions.controlNumber, DEFAULT_MIDI_TRACK_SETTINGS.controlNumber)),
          0,
          127
        ),
      },
    };
  }
  if (kind === 'midi-note') {
    const midiOptions = options.midi || {};
    return {
      ...base,
      midi: {
        ...DEFAULT_MIDI_NOTE_TRACK_SETTINGS,
        outputId:
          typeof midiOptions.outputId === 'string' && midiOptions.outputId
            ? midiOptions.outputId
            : DEFAULT_MIDI_NOTE_TRACK_SETTINGS.outputId,
        channel: clamp(
          Math.round(toFinite(midiOptions.channel, DEFAULT_MIDI_NOTE_TRACK_SETTINGS.channel)),
          1,
          16
        ),
        mode: 'note',
        note: clamp(Math.round(toFinite(midiOptions.note, DEFAULT_MIDI_NOTE_TRACK_SETTINGS.note)), 0, 127),
        velocity: clamp(
          Math.round(toFinite(midiOptions.velocity, DEFAULT_MIDI_NOTE_TRACK_SETTINGS.velocity)),
          0,
          127
        ),
      },
    };
  }
  if (kind === 'dmx') {
    const dmxOptions = options.dmx || {};
    return {
      ...base,
      dmx: {
        host:
          typeof dmxOptions.host === 'string' && dmxOptions.host.trim()
            ? dmxOptions.host.trim()
            : DEFAULT_DMX_TRACK_SETTINGS.host,
        universe: clamp(
          Math.round(toFinite(dmxOptions.universe, DEFAULT_DMX_TRACK_SETTINGS.universe)),
          0,
          32767
        ),
        channel: clamp(
          Math.round(toFinite(dmxOptions.channel, DEFAULT_DMX_TRACK_SETTINGS.channel)),
          1,
          512
        ),
      },
    };
  }
  if (kind === 'osc-color') {
    const oscColorOptions = options.oscColor || {};
    const safeLength = Math.max(Number(view?.length) || 0, 1);
    return {
      ...base,
      nodes: [
        {
          id: createNodeId(),
          t: 0,
          v: 0,
          c: normalizeTrackColor(
            oscColorOptions.gradientFrom,
            DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientFrom
          ),
          curve: 'linear',
        },
        {
          id: createNodeId(),
          t: safeLength,
          v: 255,
          c: normalizeTrackColor(
            oscColorOptions.gradientTo,
            DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientTo
          ),
          curve: 'linear',
        },
      ],
      oscColor: {
        fixtureType: normalizeOscColorFixtureType(oscColorOptions.fixtureType),
        outputRange: normalizeOscColorOutputRange(oscColorOptions.outputRange),
        gradientFrom: normalizeTrackColor(
          oscColorOptions.gradientFrom,
          DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientFrom
        ),
        gradientTo: normalizeTrackColor(
          oscColorOptions.gradientTo,
          DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientTo
        ),
      },
    };
  }
  if (kind === 'osc-array') {
    const oscArrayOptions = options.oscArray || {};
    const safeLength = Math.max(Number(view?.length) || 0, 1);
    const valueCount = normalizeOscArrayValueCount(oscArrayOptions.valueCount);
    const startValues = normalizeOscArrayValues(
      oscArrayOptions.startValues,
      valueCount,
      def,
      min,
      max
    );
    const endValues = normalizeOscArrayValues(
      oscArrayOptions.endValues,
      valueCount,
      def,
      min,
      max
    );
    return {
      ...base,
      nodes: [
        {
          id: createNodeId(),
          t: 0,
          v: startValues[0] ?? def,
          arr: startValues,
          curve: 'linear',
        },
        {
          id: createNodeId(),
          t: safeLength,
          v: endValues[0] ?? def,
          arr: endValues,
          curve: 'linear',
        },
      ],
      oscArray: {
        valueCount,
      },
    };
  }
  if (kind === 'osc-3d') {
    const osc3dOptions = normalizeOsc3dSettings(options.osc3d);
    const safeLength = Math.max(Number(view?.length) || 0, 1);
    const bounds = osc3dOptions.bounds;
    const startValues = [
      (bounds.xMin + bounds.xMax) * 0.5,
      (bounds.yMin + bounds.yMax) * 0.5,
      (bounds.zMin + bounds.zMax) * 0.5,
    ];
    return {
      ...base,
      min: bounds.yMin,
      max: bounds.yMax,
      default: startValues[1],
      nodes: [
        {
          id: createNodeId(),
          t: 0,
          v: startValues[1],
          arr: [...startValues],
          curve: 'linear',
        },
        {
          id: createNodeId(),
          t: safeLength,
          v: startValues[1],
          arr: [...startValues],
          curve: 'linear',
        },
      ],
      osc3d: osc3dOptions,
    };
  }
  if (kind === 'dmx-color') {
    const dmxColorOptions = options.dmxColor || {};
    const safeLength = Math.max(Number(view?.length) || 0, 1);
    const mapping = dmxColorOptions.mapping || {};
    return {
      ...base,
      nodes: [
        {
          id: createNodeId(),
          t: 0,
          v: 0,
          c: normalizeTrackColor(
            dmxColorOptions.gradientFrom,
            DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientFrom
          ),
          curve: 'linear',
        },
        {
          id: createNodeId(),
          t: safeLength,
          v: 255,
          c: normalizeTrackColor(
            dmxColorOptions.gradientTo,
            DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientTo
          ),
          curve: 'linear',
        },
      ],
      dmxColor: {
        host:
          typeof dmxColorOptions.host === 'string' && dmxColorOptions.host.trim()
            ? dmxColorOptions.host.trim()
            : DEFAULT_DMX_COLOR_TRACK_SETTINGS.host,
        universe: clamp(
          Math.round(toFinite(dmxColorOptions.universe, DEFAULT_DMX_COLOR_TRACK_SETTINGS.universe)),
          0,
          32767
        ),
        channelStart: clamp(
          Math.round(toFinite(dmxColorOptions.channelStart, DEFAULT_DMX_COLOR_TRACK_SETTINGS.channelStart)),
          1,
          512
        ),
        fixtureType: normalizeDmxFixtureType(dmxColorOptions.fixtureType),
        mappingChannels: normalizeMappingChannels(dmxColorOptions.mappingChannels),
        gradientFrom: normalizeTrackColor(
          dmxColorOptions.gradientFrom,
          DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientFrom
        ),
        gradientTo: normalizeTrackColor(
          dmxColorOptions.gradientTo,
          DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientTo
        ),
        mapping: {
          r: clamp(Math.round(toFinite(mapping.r, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.r)), 1, 512),
          g: clamp(Math.round(toFinite(mapping.g, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.g)), 1, 512),
          b: clamp(Math.round(toFinite(mapping.b, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.b)), 1, 512),
          w: clamp(Math.round(toFinite(mapping.w, DEFAULT_DMX_COLOR_TRACK_SETTINGS.mapping.w)), 1, 512),
        },
      },
    };
  }
  return base;
};

export const createInitialState = () => {
  const emptyProject = {
    name: 'Untitled',
    timebase: {
      bpm: 120,
      fps: 30,
      syncFps: DEFAULT_SYNC_FPS_ID,
      timeSignature: [4, 4],
      unit: 'seconds',
      sync: 'Internal',
    },
    osc: {
      ...DEFAULT_OSC_SETTINGS,
    },
    audio: {
      ...DEFAULT_AUDIO_SETTINGS,
    },
    midi: {
      ...DEFAULT_MIDI_SETTINGS,
    },
    view: {
      start: 0,
      end: DEFAULT_VIEW_SPAN_SECONDS,
      length: DEFAULT_PROJECT_LENGTH_SECONDS,
      trackHeight: 96,
      loopEnabled: false,
      loopStart: 0,
      loopEnd: DEFAULT_VIEW_SPAN_SECONDS,
    },
    cues: [],
    tracks: [],
  };
  const project = normalizeProject(deepClone(emptyProject));
  return {
    project,
    selectedTrackId: project.tracks[0]?.id ?? null,
    historyPast: [],
    historyFuture: [],
  };
};

const findNodeIndexWithinTolerance = (nodes, time, tolerance) => {
  if (!Array.isArray(nodes) || nodes.length === 0) return -1;
  const lastIndex = nodes.length - 1;
  const lastNode = nodes[lastIndex];
  if (Math.abs((lastNode?.t ?? 0) - time) <= tolerance) return lastIndex;
  if (time > (lastNode?.t ?? 0)) return -1;

  let left = 0;
  let right = lastIndex;
  while (left <= right) {
    const mid = (left + right) >> 1;
    const midTime = nodes[mid]?.t ?? 0;
    if (midTime < time) {
      left = mid + 1;
    } else if (midTime > time) {
      right = mid - 1;
    } else {
      return mid;
    }
  }

  const candidates = [left, left - 1];
  for (let i = 0; i < candidates.length; i += 1) {
    const idx = candidates[i];
    if (idx < 0 || idx >= nodes.length) continue;
    if (Math.abs((nodes[idx]?.t ?? 0) - time) <= tolerance) return idx;
  }
  return -1;
};

const findInsertIndex = (nodes, time) => {
  if (!Array.isArray(nodes) || nodes.length === 0) return 0;
  let left = 0;
  let right = nodes.length;
  while (left < right) {
    const mid = (left + right) >> 1;
    const midTime = nodes[mid]?.t ?? 0;
    if (midTime <= time) {
      left = mid + 1;
    } else {
      right = mid;
    }
  }
  return left;
};

const ingestOscSamples = (state, sampleList) => {
  const samples = Array.isArray(sampleList) ? sampleList : [sampleList];
  if (!samples.length) return state;

  const fps = Math.max(toFinite(state.project.timebase?.fps, 30), 1);
  const mergeTolerance = 0.5 / fps;
  const maxTime = Math.max(toFinite(state.project.view?.length, 0), 0);
  const tracks = [...state.project.tracks];
  const addressToIndex = new Map();
  const touchedIndexes = new Set();
  let changed = false;
  const defaultOscOutputId = getDefaultOscOutputIdFromProject(state.project);

  tracks.forEach((track, index) => {
    if (track.kind !== 'osc') return;
    const address = normalizeOscAddress(track.oscAddress, '/osc/input');
    if (!addressToIndex.has(address)) {
      addressToIndex.set(address, index);
    }
  });

  const ensureMutableTrack = (index) => {
    if (!Number.isInteger(index) || index < 0 || index >= tracks.length) return null;
    if (!touchedIndexes.has(index)) {
      tracks[index] = {
        ...tracks[index],
        nodes: Array.isArray(tracks[index].nodes) ? [...tracks[index].nodes] : [],
      };
      touchedIndexes.add(index);
    }
    return tracks[index];
  };

  const createOscTrackForAddress = (address, rawValue) => {
    const index = tracks.length + 1;
    const min = Math.floor(Math.min(0, rawValue));
    const max = Math.ceil(Math.max(1, rawValue));
    const safeMax = min === max ? min + 1 : max;
    const baseTrack = createTrack(index, state.project.view, 'osc', {
      oscOutputId: defaultOscOutputId,
    });
    const nextTrack = normalizeTrack({
      ...baseTrack,
      name: buildAutoTrackName(address, index),
      oscAddress: address,
      min,
      max: safeMax,
      default: clamp(rawValue, min, safeMax),
    });
    tracks.push(nextTrack);
    const newIndex = tracks.length - 1;
    addressToIndex.set(address, newIndex);
    touchedIndexes.add(newIndex);
    changed = true;
    return nextTrack;
  };

  samples.forEach((sample) => {
    const rawValue = Number(sample?.value);
    if (!Number.isFinite(rawValue)) return;

    const address = normalizeOscAddress(sample?.address, '/osc/input');
    const shouldRecord = sample?.record !== false;
    const time = clamp(toFinite(sample?.time, 0), 0, maxTime);

    let targetIndex = addressToIndex.get(address);
    if (!Number.isInteger(targetIndex)) {
      createOscTrackForAddress(address, rawValue);
      targetIndex = addressToIndex.get(address);
    }
    if (!Number.isInteger(targetIndex)) return;

    if (!shouldRecord) {
      return;
    }
    const target = ensureMutableTrack(targetIndex);
    if (!target) return;

    const nextMin = Math.min(target.min, rawValue);
    const nextMax = Math.max(target.max, rawValue);
    const min = nextMin;
    const max = nextMax === nextMin ? nextMin + 1 : nextMax;

    if (shouldRecord) {
      const nextValue = clamp(rawValue, min, max);
      const nodes = target.nodes;
      const lastNode = nodes.length ? nodes[nodes.length - 1] : null;

      if (!lastNode) {
        nodes.push({
          id: createNodeId(),
          t: time,
          v: nextValue,
          curve: 'linear',
        });
        changed = true;
      } else if (Math.abs(lastNode.t - time) <= mergeTolerance) {
        if (lastNode.t !== time || lastNode.v !== nextValue) {
          lastNode.t = time;
          lastNode.v = nextValue;
          changed = true;
        }
      } else if (time > lastNode.t) {
        nodes.push({
          id: createNodeId(),
          t: time,
          v: nextValue,
          curve: 'linear',
        });
        changed = true;
      } else {
        const nodeIndex = findNodeIndexWithinTolerance(nodes, time, mergeTolerance);
        if (nodeIndex >= 0) {
          const previous = nodes[nodeIndex];
          if (previous.t !== time || previous.v !== nextValue) {
            nodes[nodeIndex] = {
              ...previous,
              t: time,
              v: nextValue,
            };
            changed = true;
          }
        } else {
          const insertIndex = findInsertIndex(nodes, time);
          nodes.splice(insertIndex, 0, {
            id: createNodeId(),
            t: time,
            v: nextValue,
            curve: 'linear',
          });
          changed = true;
        }
      }
    }

    if (
      target.min !== min
      || target.max !== max
      || normalizeOscAddress(target.oscAddress, '/osc/input') !== address
    ) {
      target.min = min;
      target.max = max;
      target.default = clamp(toFinite(target.default, min), min, max);
      target.oscAddress = address;
      changed = true;
    }
  });

  if (!changed) return state;

  touchedIndexes.forEach((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= tracks.length) return;
    const target = tracks[index];
    if (!target || target.kind !== 'osc') return;
    if (!Number.isFinite(target.min) || !Number.isFinite(target.max)) {
      target.min = toFinite(target.min, 0);
      target.max = toFinite(target.max, 1);
    }
    if (target.max <= target.min) {
      target.max = target.min + 1;
    }
    target.default = clamp(toFinite(target.default, target.min), target.min, target.max);
  });

  const firstTouchedIndex = touchedIndexes.size ? [...touchedIndexes][0] : -1;
  const nextSelectedTrackId =
    state.selectedTrackId
    ?? (firstTouchedIndex >= 0 ? tracks[firstTouchedIndex]?.id ?? null : null);

  return {
    ...state,
    project: { ...state.project, tracks },
    selectedTrackId: nextSelectedTrackId,
  };
};

const reduceProjectState = (state, action) => {
  switch (action.type) {
    case 'select-track':
      return { ...state, selectedTrackId: action.id };
    case 'add-composition': {
      const syncedProject = syncActiveCompositionInProject(state.project);
      const sourceView = normalizeView(syncedProject.view || {
        start: 0,
        end: DEFAULT_VIEW_SPAN_SECONDS,
        length: DEFAULT_PROJECT_LENGTH_SECONDS,
        trackHeight: 96,
      });
      const view = normalizeView({
        start: 0,
        end: Math.min(DEFAULT_VIEW_SPAN_SECONDS, sourceView.length),
        length: sourceView.length,
        trackHeight: sourceView.trackHeight,
        loopEnabled: false,
        loopStart: 0,
        loopEnd: Math.min(DEFAULT_VIEW_SPAN_SECONDS, sourceView.length),
      });
      const nextIndex = (syncedProject.compositions?.length || 0) + 1;
      const composition = {
        id: createCompositionId(),
        name:
          typeof action.name === 'string' && action.name.trim()
            ? action.name.trim()
            : `Composition ${String(nextIndex).padStart(2, '0')}`,
        view,
        cues: [],
        tracks: [],
      };
      return {
        ...state,
        project: {
          ...syncedProject,
          activeCompositionId: composition.id,
          compositions: [...(syncedProject.compositions || []), composition],
          view: composition.view,
          cues: composition.cues,
          tracks: composition.tracks,
        },
        selectedTrackId: null,
      };
    }
    case 'delete-composition': {
      const syncedProject = syncActiveCompositionInProject(state.project);
      const compositions = [...(syncedProject.compositions || [])];
      if (compositions.length <= 1) return state;
      const deleteId = typeof action.id === 'string' && action.id
        ? action.id
        : syncedProject.activeCompositionId;
      const deleteIndex = compositions.findIndex((composition) => composition.id === deleteId);
      if (deleteIndex < 0) return state;
      compositions.splice(deleteIndex, 1);
      const nextActiveId =
        syncedProject.activeCompositionId === deleteId
          ? (compositions[Math.min(deleteIndex, compositions.length - 1)]?.id || compositions[0]?.id || null)
          : syncedProject.activeCompositionId;
      const activeComposition = compositions.find((composition) => composition.id === nextActiveId)
        || compositions[0];
      if (!activeComposition) return state;
      return {
        ...state,
        project: {
          ...syncedProject,
          compositions,
          activeCompositionId: activeComposition.id,
          view: activeComposition.view,
          cues: activeComposition.cues,
          tracks: activeComposition.tracks,
        },
        selectedTrackId: activeComposition.tracks[0]?.id ?? null,
      };
    }
    case 'switch-composition': {
      const id = typeof action.id === 'string' ? action.id : '';
      if (!id) return state;
      const syncedProject = syncActiveCompositionInProject(state.project);
      const target = (syncedProject.compositions || []).find((composition) => composition.id === id);
      if (!target) return state;
      return {
        ...state,
        project: {
          ...syncedProject,
          activeCompositionId: target.id,
          view: target.view,
          cues: target.cues,
          tracks: target.tracks,
        },
        selectedTrackId: target.tracks[0]?.id ?? null,
      };
    }
    case 'move-composition': {
      const sourceId = typeof action.sourceId === 'string' ? action.sourceId : '';
      const targetId = typeof action.targetId === 'string' ? action.targetId : '';
      if (!sourceId || !targetId || sourceId === targetId) return state;
      const syncedProject = syncActiveCompositionInProject(state.project);
      const compositions = [...(syncedProject.compositions || [])];
      const sourceIndex = compositions.findIndex((composition) => composition.id === sourceId);
      const targetIndex = compositions.findIndex((composition) => composition.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return state;

      const [moved] = compositions.splice(sourceIndex, 1);
      const nextTargetIndex = compositions.findIndex((composition) => composition.id === targetId);
      const insertAt = action.position === 'after' ? nextTargetIndex + 1 : nextTargetIndex;
      compositions.splice(Math.max(0, Math.min(insertAt, compositions.length)), 0, moved);

      return {
        ...state,
        project: { ...syncedProject, compositions },
      };
    }
    case 'update-composition': {
      const id = typeof action.id === 'string' ? action.id : '';
      if (!id || !action.patch) return state;
      const syncedProject = syncActiveCompositionInProject(state.project);
      let changed = false;
      const compositions = (syncedProject.compositions || []).map((composition) => {
        if (composition.id !== id) return composition;
        const next = {
          ...composition,
          name:
            typeof action.patch.name === 'string' && action.patch.name.trim()
              ? action.patch.name.trim()
              : composition.name,
        };
        if (next.name !== composition.name) changed = true;
        return next;
      });
      if (!changed) return state;
      return {
        ...state,
        project: { ...syncedProject, compositions },
      };
    }
    case 'set-unit':
      return {
        ...state,
        project: {
          ...state.project,
          timebase: { ...state.project.timebase, unit: action.unit },
        },
      };
    case 'update-project': {
      const next = {
        ...state,
        project: {
          ...state.project,
          ...action.patch,
          timebase: { ...state.project.timebase, ...action.patch.timebase },
          view: { ...state.project.view, ...action.patch.view },
          osc: { ...state.project.osc, ...action.patch.osc },
          audio: {
            ...state.project.audio,
            ...action.patch.audio,
            ltc: { ...state.project.audio?.ltc, ...action.patch.audio?.ltc },
          },
          midi: { ...state.project.midi, ...action.patch.midi },
        },
      };
      return {
        ...next,
        project: normalizeProject(syncActiveCompositionInProject(next.project)),
      };
    }
    case 'add-track': {
      const index = state.project.tracks.length + 1;
      const defaultOscOutputId = getDefaultOscOutputIdFromProject(state.project);
      const track = normalizeTrack(
        createTrack(index, state.project.view, action.kind || 'osc', {
          ...(action.options || {}),
          oscOutputId:
            typeof action.options?.oscOutputId === 'string' && action.options.oscOutputId
              ? action.options.oscOutputId
              : defaultOscOutputId,
        }),
        pickTrackColor(index)
      );
      return {
        ...state,
        project: {
          ...state.project,
          tracks: [...state.project.tracks, track],
        },
        selectedTrackId: track.id,
      };
    }
    case 'add-tracks': {
      const items = Array.isArray(action.items) ? action.items : [];
      if (!items.length) return state;
      const startIndex = state.project.tracks.length + 1;
      const defaultOscOutputId = getDefaultOscOutputIdFromProject(state.project);
      const addedTracks = items.map((item, offset) => {
        const index = startIndex + offset;
        const kind = item?.kind || 'osc';
        return normalizeTrack(
          createTrack(index, state.project.view, kind, {
            ...(item?.options || {}),
            oscOutputId:
              typeof item?.options?.oscOutputId === 'string' && item.options.oscOutputId
                ? item.options.oscOutputId
                : defaultOscOutputId,
          }),
          pickTrackColor(index)
        );
      });
      if (!addedTracks.length) return state;
      return {
        ...state,
        project: {
          ...state.project,
          tracks: [...state.project.tracks, ...addedTracks],
        },
        selectedTrackId: addedTracks[addedTracks.length - 1]?.id ?? state.selectedTrackId,
      };
    }
    case 'paste-tracks': {
      const sourceTracks = Array.isArray(action.tracks) ? action.tracks.filter(Boolean) : [];
      if (!sourceTracks.length) return state;
      const oscOutputIds = getOscOutputIdSetFromProject(state.project);
      const defaultOscOutputId = getDefaultOscOutputIdFromProject(state.project);
      const existingTracks = [...state.project.tracks];
      let insertIndex = existingTracks.length;
      if (action.insertAfterId) {
        const anchorIndex = existingTracks.findIndex((track) => track.id === action.insertAfterId);
        if (anchorIndex >= 0) insertIndex = anchorIndex + 1;
      }
      const addedTracks = sourceTracks.map((source, offset) => {
        const baseName = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : 'Track';
        const copiedNodes = Array.isArray(source.nodes)
          ? source.nodes.map((node) => ({ ...node, id: undefined }))
          : [];
        const normalized = normalizeTrack({
          ...source,
          id: undefined,
          name: `${baseName} Copy`,
          nodes: copiedNodes,
        }, pickTrackColor(insertIndex + offset + 1));
        if (isOscTrackKind(normalized.kind)) {
          const outputId =
            typeof normalized.oscOutputId === 'string' && normalized.oscOutputId
              ? normalized.oscOutputId
              : defaultOscOutputId;
          normalized.oscOutputId = oscOutputIds.has(outputId) ? outputId : defaultOscOutputId;
        }
        return normalized;
      });
      const tracks = [...existingTracks];
      tracks.splice(insertIndex, 0, ...addedTracks);
      return {
        ...state,
        project: { ...state.project, tracks },
        selectedTrackId: addedTracks[addedTracks.length - 1]?.id ?? state.selectedTrackId,
      };
    }
    case 'move-track': {
      const tracks = [...state.project.tracks];
      const sourceIndex = tracks.findIndex((track) => track.id === action.sourceId);
      const targetIndex = tracks.findIndex((track) => track.id === action.targetId);
      if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return state;

      const [moved] = tracks.splice(sourceIndex, 1);
      const nextTargetIndex = tracks.findIndex((track) => track.id === action.targetId);
      const insertAt = action.position === 'after' ? nextTargetIndex + 1 : nextTargetIndex;
      tracks.splice(Math.max(0, Math.min(insertAt, tracks.length)), 0, moved);

      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'move-tracks': {
      const sourceIds = Array.isArray(action.sourceIds) ? action.sourceIds.filter(Boolean) : [];
      if (!sourceIds.length || !action.targetId) return state;
      const sourceSet = new Set(sourceIds);
      if (sourceSet.has(action.targetId)) return state;

      const tracks = [...state.project.tracks];
      const moving = tracks.filter((track) => sourceSet.has(track.id));
      if (!moving.length) return state;
      const remaining = tracks.filter((track) => !sourceSet.has(track.id));
      const targetIndex = remaining.findIndex((track) => track.id === action.targetId);
      if (targetIndex < 0) return state;

      const insertAt = action.position === 'before' ? targetIndex : targetIndex + 1;
      const nextTracks = [...remaining];
      nextTracks.splice(Math.max(0, Math.min(insertAt, nextTracks.length)), 0, ...moving);

      return {
        ...state,
        project: { ...state.project, tracks: nextTracks },
      };
    }
    case 'ingest-osc-sample':
      return ingestOscSamples(state, action);
    case 'ingest-osc-batch':
      return ingestOscSamples(state, action.samples);
    case 'update-track': {
      const tracks = state.project.tracks.map((track) => {
        if (track.id !== action.id) return track;
        const dmxColorPatch = action.patch.dmxColor || {};
        const oscColorPatch = action.patch.oscColor || {};
        const oscArrayPatch = action.patch.oscArray || {};
        const osc3dPatch = action.patch.osc3d || {};
        return normalizeTrack({
          ...track,
          ...action.patch,
          group: { ...track.group, ...action.patch.group },
          audio: { ...track.audio, ...action.patch.audio },
          midi: { ...track.midi, ...action.patch.midi },
          dmx: { ...track.dmx, ...action.patch.dmx },
          oscArray: {
            ...track.oscArray,
            ...oscArrayPatch,
          },
          osc3d: {
            ...track.osc3d,
            ...osc3dPatch,
            bounds: { ...track.osc3d?.bounds, ...osc3dPatch.bounds },
          },
          oscColor: {
            ...track.oscColor,
            ...oscColorPatch,
          },
          dmxColor: {
            ...track.dmxColor,
            ...dmxColorPatch,
            mapping: { ...track.dmxColor?.mapping, ...dmxColorPatch.mapping },
          },
        });
      });
      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'update-tracks-color': {
      const ids = new Set(Array.isArray(action.ids) ? action.ids : []);
      if (!ids.size) return state;
      const color = normalizeTrackColor(action.color, '#5dd8c7');
      let changed = false;
      const tracks = state.project.tracks.map((track) => {
        if (!ids.has(track.id)) return track;
        if (track.color === color) return track;
        changed = true;
        return normalizeTrack({ ...track, color }, track.color || color);
      });
      if (!changed) return state;
      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'delete-track': {
      const tracks = state.project.tracks.filter((track) => track.id !== action.id);
      const selectedTrackId =
        state.selectedTrackId === action.id ? tracks[0]?.id ?? null : state.selectedTrackId;
      return {
        ...state,
        project: { ...state.project, tracks },
        selectedTrackId,
      };
    }
    case 'delete-tracks': {
      const ids = new Set(Array.isArray(action.ids) ? action.ids : []);
      if (!ids.size) return state;
      const tracks = state.project.tracks.filter((track) => !ids.has(track.id));
      const selectedTrackId =
        state.selectedTrackId && !ids.has(state.selectedTrackId)
          ? state.selectedTrackId
          : (tracks[0]?.id ?? null);
      return {
        ...state,
        project: { ...state.project, tracks },
        selectedTrackId,
      };
    }
    case 'load-project': {
      const project = normalizeProject(action.project);
      return {
        ...state,
        project: {
          ...project,
          timebase: { ...state.project.timebase, ...project.timebase },
        },
        selectedTrackId: project.tracks[0]?.id ?? null,
      };
    }
    case 'add-node': {
      const tracks = state.project.tracks.map((track) => {
        if (track.id !== action.id) return track;
        const node = {
          id: createNodeId(),
          curve: 'linear',
          ...action.node,
          v: track.kind === 'osc-flag'
            ? toFinite(action.node?.v, 1)
            : track.kind === 'midi'
              ? normalizeMidiCcValue(action.node?.v, track.default)
            : (track.kind === 'dmx' || track.kind === 'dmx-color')
              ? normalizeDmxValue(action.node?.v, track.default)
            : track.kind === 'midi-note'
              ? clamp(Math.round(toFinite(action.node?.v, track.default)), 0, 127)
            : clamp(action.node.v, track.min, track.max),
        };
        if (track.kind === 'osc-flag') {
          node.a = normalizeOscAddress(
            action.node?.a,
            normalizeOscAddress(track.oscAddress, '/osc/flag')
          );
          node.d = Math.max(toFinite(action.node?.d, 1), 0);
          node.y = clamp(toFinite(action.node?.y, 0.5), 0, 1);
        }
        if (track.kind === 'dmx-color') {
          node.c = normalizeTrackColor(
            action.node?.c,
            track.dmxColor?.gradientFrom || DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientFrom
          );
        }
        if (track.kind === 'osc-color') {
          node.c = normalizeTrackColor(
            action.node?.c,
            track.oscColor?.gradientFrom || DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientFrom
          );
        }
        if (track.kind === 'osc-array') {
          const count = normalizeOscArrayValueCount(track.oscArray?.valueCount);
          node.arr = normalizeOscArrayValues(
            action.node?.arr,
            count,
            node.v,
            track.min,
            track.max
          );
          node.v = node.arr[0] ?? node.v;
        }
        if (track.kind === 'osc-3d') {
          const bounds = normalizeOsc3dSettings(track.osc3d).bounds;
          const raw = Array.isArray(action.node?.arr) ? action.node.arr : [];
          const xFallback = (bounds.xMin + bounds.xMax) * 0.5;
          const yFallback = clamp(
            toFinite(action.node?.v, track.default),
            bounds.yMin,
            bounds.yMax
          );
          const zFallback = (bounds.zMin + bounds.zMax) * 0.5;
          const x = clamp(toFinite(raw[0], xFallback), bounds.xMin, bounds.xMax);
          const y = clamp(toFinite(raw[1], yFallback), bounds.yMin, bounds.yMax);
          const z = clamp(toFinite(raw[2], zFallback), bounds.zMin, bounds.zMax);
          node.arr = [x, y, z];
          node.v = y;
        }
        if (track.kind === 'midi-note') {
          node.d = Math.max(toFinite(action.node?.d, 0.5), 0.01);
        }
        return normalizeTrack({
          ...track,
          nodes: [...track.nodes, node],
        });
      });
      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'add-nodes': {
      const incomingNodes = Array.isArray(action.nodes) ? action.nodes : [];
      if (!incomingNodes.length) return state;
      const tracks = state.project.tracks.map((track) => {
        if (track.id !== action.id) return track;
        const nodes = incomingNodes.map((node) => ({
          id: createNodeId(),
          curve: node?.curve || 'linear',
          t: Math.max(toFinite(node?.t, 0), 0),
          v: track.kind === 'osc-flag'
            ? toFinite(node?.v, 1)
            : track.kind === 'midi'
              ? normalizeMidiCcValue(node?.v, track.default)
            : (track.kind === 'dmx' || track.kind === 'dmx-color')
              ? normalizeDmxValue(node?.v, track.default)
            : track.kind === 'midi-note'
              ? clamp(Math.round(toFinite(node?.v, track.default)), 0, 127)
            : clamp(toFinite(node?.v, track.default), track.min, track.max),
          ...(track.kind === 'osc-flag'
            ? {
              a: normalizeOscAddress(
                node?.a,
                normalizeOscAddress(track.oscAddress, '/osc/flag')
              ),
              d: Math.max(toFinite(node?.d, 1), 0),
              y: clamp(toFinite(node?.y, 0.5), 0, 1),
            }
            : {}),
          ...(track.kind === 'dmx-color'
            ? {
              c: normalizeTrackColor(
                node?.c,
                track.dmxColor?.gradientFrom || DEFAULT_DMX_COLOR_TRACK_SETTINGS.gradientFrom
              ),
            }
            : {}),
          ...(track.kind === 'osc-color'
            ? {
              c: normalizeTrackColor(
                node?.c,
                track.oscColor?.gradientFrom || DEFAULT_OSC_COLOR_TRACK_SETTINGS.gradientFrom
              ),
            }
            : {}),
          ...(track.kind === 'osc-array'
            ? {
              arr: normalizeOscArrayValues(
                node?.arr,
                normalizeOscArrayValueCount(track.oscArray?.valueCount),
                toFinite(node?.v, track.default),
                track.min,
                track.max
              ),
            }
            : {}),
          ...(track.kind === 'osc-3d'
            ? (() => {
              const bounds = normalizeOsc3dSettings(track.osc3d).bounds;
              const raw = Array.isArray(node?.arr) ? node.arr : [];
              const xFallback = (bounds.xMin + bounds.xMax) * 0.5;
              const yFallback = clamp(toFinite(node?.v, track.default), bounds.yMin, bounds.yMax);
              const zFallback = (bounds.zMin + bounds.zMax) * 0.5;
              const x = clamp(toFinite(raw[0], xFallback), bounds.xMin, bounds.xMax);
              const y = clamp(toFinite(raw[1], yFallback), bounds.yMin, bounds.yMax);
              const z = clamp(toFinite(raw[2], zFallback), bounds.zMin, bounds.zMax);
              return {
                arr: [x, y, z],
                v: y,
              };
            })()
            : {}),
          ...(track.kind === 'midi-note'
            ? {
              d: Math.max(toFinite(node?.d, 0.5), 0.01),
            }
            : {}),
        }));
        if (track.kind === 'osc-array') {
          nodes.forEach((node) => {
            if (!Array.isArray(node.arr)) return;
            node.v = Number.isFinite(node.arr[0]) ? node.arr[0] : node.v;
          });
        }
        return normalizeTrack({
          ...track,
          nodes: [...track.nodes, ...nodes],
        });
      });
      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'delete-nodes': {
      if (!Array.isArray(action.nodeIds) || action.nodeIds.length === 0) return state;
      const ids = new Set(action.nodeIds);
      const tracks = state.project.tracks.map((track) => {
        if (track.id !== action.id) return track;
        return normalizeTrack({
          ...track,
          nodes: track.nodes.filter((node) => !ids.has(node.id)),
        });
      });
      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'add-cue': {
      const cue = {
        id: createCueId(),
        t: clamp(action.time, 0, state.project.view.length),
      };
      const cues = [...(state.project.cues || []), cue].sort((a, b) => a.t - b.t);
      return {
        ...state,
        project: { ...state.project, cues },
      };
    }
    case 'update-cue': {
      const cues = (state.project.cues || [])
        .map((cue) => (cue.id === action.id ? { ...cue, t: action.time } : cue))
        .map((cue) => ({ ...cue, t: clamp(cue.t, 0, state.project.view.length) }))
        .sort((a, b) => a.t - b.t);
      return {
        ...state,
        project: { ...state.project, cues },
      };
    }
    case 'delete-cue': {
      const cues = (state.project.cues || []).filter((cue) => cue.id !== action.id);
      return {
        ...state,
        project: { ...state.project, cues },
      };
    }
    case 'update-node': {
      const tracks = state.project.tracks.map((track) => {
        if (track.id !== action.id) return track;
        const nodes = track.nodes.map((node) => {
          if (node.id !== action.nodeId) return node;
          return { ...node, ...action.patch };
        });
        return normalizeTrack({ ...track, nodes });
      });
      return {
        ...state,
        project: { ...state.project, tracks },
      };
    }
    case 'zoom-time': {
      const view = state.project.view;
      const span = view.end - view.start;
      const factor = action.direction > 0 ? 0.8 : 1.25;
      const minSpan = 1;
      const maxSpan = view.length;
      const nextSpan = clamp(span * factor, minSpan, maxSpan);
      const center = action.center ?? (view.start + view.end) / 2;
      let start = center - nextSpan / 2;
      let end = center + nextSpan / 2;
      if (start < 0) {
        end -= start;
        start = 0;
      }
      if (end > view.length) {
        start -= end - view.length;
        end = view.length;
        if (start < 0) start = 0;
      }
      return {
        ...state,
        project: {
          ...state.project,
          view: { ...view, start, end },
        },
      };
    }
    case 'scroll-time': {
      const view = state.project.view;
      const span = view.end - view.start;
      let start = clamp(action.start, 0, Math.max(view.length - span, 0));
      let end = start + span;
      return {
        ...state,
        project: {
          ...state.project,
          view: { ...view, start, end },
        },
      };
    }
    case 'zoom-track-height': {
      const view = state.project.view;
      const next = clamp(view.trackHeight + action.delta, 64, 320);
      return {
        ...state,
        project: {
          ...state.project,
          view: { ...view, trackHeight: next },
        },
      };
    }
    default:
      return state;
  }
};

const createHistorySnapshot = (state) => ({
  project: state.project,
  selectedTrackId: state.selectedTrackId,
});

const trimHistory = (entries) => {
  if (entries.length <= HISTORY_LIMIT) return entries;
  return entries.slice(entries.length - HISTORY_LIMIT);
};

const shouldTrackHistory = (action) => {
  if (action?.meta?.skipHistory) return false;
  return HISTORY_ACTIONS.has(action.type);
};

export const projectReducer = (state, action) => {
  if (action.type === 'undo') {
    const past = state.historyPast || [];
    if (!past.length) return state;
    const previous = past[past.length - 1];
    const current = createHistorySnapshot(state);
    return {
      ...state,
      project: previous.project,
      selectedTrackId: previous.selectedTrackId,
      historyPast: past.slice(0, -1),
      historyFuture: trimHistory([current, ...(state.historyFuture || [])]),
    };
  }

  if (action.type === 'redo') {
    const future = state.historyFuture || [];
    if (!future.length) return state;
    const next = future[0];
    const current = createHistorySnapshot(state);
    return {
      ...state,
      project: next.project,
      selectedTrackId: next.selectedTrackId,
      historyPast: trimHistory([...(state.historyPast || []), current]),
      historyFuture: future.slice(1),
    };
  }

  const reducedState = reduceProjectState(state, action);
  if (reducedState === state) return state;
  const nextState = reducedState.project === state.project
    ? reducedState
    : {
      ...reducedState,
      project: syncActiveCompositionInProject(reducedState.project),
    };

  if (!shouldTrackHistory(action)) {
    return {
      ...nextState,
      historyPast: state.historyPast || [],
      historyFuture: state.historyFuture || [],
    };
  }

  return {
    ...nextState,
    historyPast: trimHistory([...(state.historyPast || []), createHistorySnapshot(state)]),
    historyFuture: [],
  };
};
