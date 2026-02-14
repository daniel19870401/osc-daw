const deepClone = (value) => JSON.parse(JSON.stringify(value));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const AUDIO_BUFFER_SIZES = [128, 256, 512, 1024, 2048, 4096, 8192, 16384];
const HISTORY_LIMIT = 200;
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
  listenPort: 9001,
  controlPort: 9002,
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
  mode: 'cc',
  controlNumber: 1,
  note: 60,
  velocity: 100,
};
const DEFAULT_DMX_TRACK_SETTINGS = {
  host: '127.0.0.1',
  universe: 0,
  channel: 1,
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

const normalizeOscAddress = (address, fallback = '/osc/input') => {
  if (typeof address !== 'string') return fallback;
  const trimmed = address.trim();
  if (!trimmed) return fallback;
  if (trimmed.startsWith('/')) return trimmed;
  return `/${trimmed}`;
};

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
    color: normalizeTrackColor(track.color, fallbackColor),
    mute: Boolean(track.mute),
    solo: Boolean(track.solo),
    min,
    max,
  };
  if (!next.kind) next.kind = 'osc';
  if (!next.id) next.id = `track-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

  if (next.kind === 'midi') {
    const midi = track.midi || {};
    const mode = midi.mode === 'note' ? 'note' : 'cc';
    next.midi = {
      outputId:
        typeof midi.outputId === 'string' && midi.outputId
          ? midi.outputId
          : DEFAULT_MIDI_TRACK_SETTINGS.outputId,
      channel: clamp(Math.round(toFinite(midi.channel, DEFAULT_MIDI_TRACK_SETTINGS.channel)), 1, 16),
      mode,
      controlNumber: clamp(
        Math.round(toFinite(midi.controlNumber, DEFAULT_MIDI_TRACK_SETTINGS.controlNumber)),
        0,
        127
      ),
      note: clamp(Math.round(toFinite(midi.note, DEFAULT_MIDI_TRACK_SETTINGS.note)), 0, 127),
      velocity: clamp(Math.round(toFinite(midi.velocity, DEFAULT_MIDI_TRACK_SETTINGS.velocity)), 0, 127),
    };
    if (mode === 'note') {
      next.min = 0;
      next.max = 1;
    } else {
      next.min = 0;
      next.max = 127;
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

  if (next.kind !== 'osc') {
    next.oscAddress = '';
  }

  next.default = clamp(toFinite(next.default, next.min), next.min, next.max);
  next.nodes = (track.nodes || [])
    .map((node) => ({
      id: node.id ?? createNodeId(),
      ...node,
      t: Math.max(toFinite(node.t, 0), 0),
      v: clamp(toFinite(node.v, next.default), next.min, next.max),
      curve: node.curve || 'linear',
    }))
    .sort((a, b) => a.t - b.t);
  if (next.kind === 'audio') {
    const audioSrc = typeof next.audio?.src === 'string' ? next.audio.src : '';
    next.audio = {
      src: '',
      name: '',
      duration: 0,
      volume: 1,
      ...(next.audio || {}),
      src: audioSrc.startsWith('file://') ? '' : audioSrc,
      duration: Math.max(toFinite(next.audio?.duration, 0), 0),
      volume: clamp(toFinite(next.audio?.volume, 1), 0, 1),
    };
  }
  return next;
};

const createNodeId = () => `node-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const createCueId = () => `cue-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
const createCompositionId = () => `composition-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;

const normalizeView = (view) => {
  const length = Math.max(toFinite(view.length, 120), 1);
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
  return {
    ...view,
    trackHeight: clamp(toFinite(view.trackHeight, 96), 64, 640),
    length,
    start,
    end,
  };
};

const normalizeCues = (cues, length) => (Array.isArray(cues) ? cues : [])
  .map((cue) => ({
    id: cue.id ?? createCueId(),
    t: clamp(cue.t ?? 0, 0, length),
  }))
  .sort((a, b) => a.t - b.t);

const normalizeTracks = (tracks) => (Array.isArray(tracks) ? tracks : [])
  .map((track, index) => normalizeTrack(track, pickTrackColor(index + 1)));

const normalizeComposition = (composition, index, fallbackView) => {
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
    tracks: normalizeTracks(composition?.tracks),
  };
};

const syncActiveCompositionInProject = (project) => {
  const compositions = Array.isArray(project.compositions) ? project.compositions : [];
  if (!compositions.length) return project;
  const activeId =
    typeof project.activeCompositionId === 'string' && project.activeCompositionId
      ? project.activeCompositionId
      : compositions[0].id;
  const view = normalizeView(project.view || compositions[0].view);
  const cues = normalizeCues(project.cues, view.length);
  const tracks = normalizeTracks(project.tracks);
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
  const fallbackView = normalizeView(project.view || { start: 0, end: 8, length: 120, trackHeight: 96 });
  const fallbackCues = normalizeCues(project.cues, fallbackView.length);
  const fallbackTracks = normalizeTracks(project.tracks);
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
    host:
      typeof project.osc?.host === 'string' && project.osc.host.trim()
        ? project.osc.host.trim()
        : DEFAULT_OSC_SETTINGS.host,
    port: normalizePort(project.osc?.port, DEFAULT_OSC_SETTINGS.port),
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
    .map((composition, index) => normalizeComposition(composition, index + 1, fallbackView));
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
      : kind === 'midi'
        ? `MIDI ${String(index).padStart(2, '0')}`
        : kind === 'dmx'
          ? `DMX ${String(index).padStart(2, '0')}`
        : `Track ${String(index).padStart(2, '0')}`;
  const min = kind === 'midi' || kind === 'dmx' ? 0 : 0;
  const max = kind === 'midi' ? 127 : (kind === 'dmx' ? 255 : 1);
  const def = kind === 'audio' ? 1 : (kind === 'midi' || kind === 'dmx' ? 0 : 0.5);
  const base = {
    id,
    name,
    kind,
    color: pickTrackColor(index),
    mute: false,
    solo: false,
    min,
    max,
    default: def,
    oscAddress: kind === 'osc' ? `/track/${index}/value` : '',
    nodes: [],
  };
  if (kind === 'audio') {
    return { ...base, audio: { src: '', name: '', duration: 0, volume: 1 } };
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
        mode: midiOptions.mode === 'note' ? 'note' : 'cc',
        controlNumber: clamp(
          Math.round(toFinite(midiOptions.controlNumber, DEFAULT_MIDI_TRACK_SETTINGS.controlNumber)),
          0,
          127
        ),
        note: clamp(Math.round(toFinite(midiOptions.note, DEFAULT_MIDI_TRACK_SETTINGS.note)), 0, 127),
        velocity: clamp(
          Math.round(toFinite(midiOptions.velocity, DEFAULT_MIDI_TRACK_SETTINGS.velocity)),
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
      end: 8,
      length: 120,
      trackHeight: 96,
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
    const baseTrack = createTrack(index, state.project.view, 'osc');
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
      const sourceView = normalizeView(syncedProject.view || { start: 0, end: 8, length: 120, trackHeight: 96 });
      const view = normalizeView({
        start: 0,
        end: Math.min(8, sourceView.length),
        length: sourceView.length,
        trackHeight: sourceView.trackHeight,
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
      const track = normalizeTrack(
        createTrack(index, state.project.view, action.kind || 'osc', action.options || {}),
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
      const addedTracks = items.map((item, offset) => {
        const index = startIndex + offset;
        const kind = item?.kind || 'osc';
        return normalizeTrack(
          createTrack(index, state.project.view, kind, item?.options || {}),
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
        return normalizeTrack({
          ...source,
          id: undefined,
          name: `${baseName} Copy`,
          nodes: copiedNodes,
        }, pickTrackColor(insertIndex + offset + 1));
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
        return normalizeTrack({
          ...track,
          ...action.patch,
          audio: { ...track.audio, ...action.patch.audio },
          midi: { ...track.midi, ...action.patch.midi },
          dmx: { ...track.dmx, ...action.patch.dmx },
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
          v: clamp(action.node.v, track.min, track.max),
        };
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
          v: clamp(toFinite(node?.v, track.default), track.min, track.max),
        }));
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
