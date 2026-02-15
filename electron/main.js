const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const dgram = require('dgram');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const fs = require('fs');
const { createNativeAudioEngine } = require('./nativeAudioEngine');
let midi = null;
try {
  midi = require('@julusian/midi');
} catch (error) {
  // MIDI virtual port support is optional at runtime.
}

const isDev = !app.isPackaged;
const useDevServer = process.env.OSCONDUCTOR_DEV_SERVER === '1';
const enableDebugLog = isDev && process.env.OSCONDUCTOR_DEBUG === '1';
const oscSocket = dgram.createSocket('udp4');
const artNetSocket = dgram.createSocket('udp4');
let oscListenPort = null;
let oscControlSocket = null;
let oscControlPort = null;
const APP_MIDI_INPUT_PORT_NAME = 'OSConductor MIDI IN';
const APP_MIDI_OUTPUT_PORT_NAME = 'OSConductor MIDI OUT';
let appMidiInputPort = null;
let appMidiOutputPort = null;
let oscRecorderWorker = null;
let oscRecorderRpcId = 1;
const oscRecorderPending = new Map();
const ARTNET_DEFAULT_PORT = 6454;
const ARTNET_CHANNEL_COUNT = 512;
const ARTNET_PROTOCOL_VERSION = 14;
const AUDIO_DEVICE_CACHE_TTL_MS = 8000;
let audioOutputChannelsCache = {
  timestamp: 0,
  byLabel: {},
  defaultOutputLabel: null,
  defaultOutputChannels: 2,
};
let audioOutputChannelsPending = null;
const nativeAudioEngine = createNativeAudioEngine();

const align4 = (size) => (size + 3) & ~0x03;

const encodeOscString = (value) => {
  const text = typeof value === 'string' ? value : '';
  const raw = Buffer.from(text, 'utf8');
  const size = align4(raw.length + 1);
  const out = Buffer.alloc(size);
  raw.copy(out, 0);
  out[raw.length] = 0;
  return out;
};

const encodeOscFloat = (value) => {
  const out = Buffer.alloc(4);
  out.writeFloatBE(Number(value) || 0, 0);
  return out;
};

const encodeOscInt = (value) => {
  const out = Buffer.alloc(4);
  out.writeInt32BE(Math.round(Number(value) || 0), 0);
  return out;
};

const normalizeOscValueType = (valueType) => (
  valueType === 'int' ? 'int' : (valueType === 'float' ? 'float' : 'auto')
);

const buildOscPacket = (address, value, valueType = 'auto') => {
  const safeAddress = typeof address === 'string' && address.startsWith('/') ? address : '/value';
  const addressBuffer = encodeOscString(safeAddress);
  const mode = normalizeOscValueType(valueType);
  if (Array.isArray(value)) {
    const values = value.map((item) => (Number.isFinite(Number(item)) ? Number(item) : 0));
    const tags = values.map((item) => {
      if (mode === 'int') return 'i';
      if (mode === 'float') return 'f';
      return Number.isInteger(item) ? 'i' : 'f';
    });
    const typeTagBuffer = encodeOscString(`,${tags.join('')}`);
    const valueBuffers = values.map((item, index) => (
      tags[index] === 'i' ? encodeOscInt(item) : encodeOscFloat(item)
    ));
    return Buffer.concat([addressBuffer, typeTagBuffer, ...valueBuffers]);
  }
  const scalar = Number.isFinite(Number(value)) ? Number(value) : 0;
  const useInt = mode === 'int';
  const typeTagBuffer = encodeOscString(useInt ? ',i' : ',f');
  const valueBuffer = useInt ? encodeOscInt(scalar) : encodeOscFloat(scalar);
  return Buffer.concat([addressBuffer, typeTagBuffer, valueBuffer]);
};

const buildArtNetDmxPacket = (payload = {}) => {
  const universe = Math.max(0, Math.min(32767, Math.round(Number(payload?.universe) || 0)));
  const sequence = Math.max(0, Math.min(255, Math.round(Number(payload?.sequence) || 0)));
  const sourceData = Array.isArray(payload?.data) ? payload.data : [];
  const dmxData = Buffer.alloc(ARTNET_CHANNEL_COUNT, 0);
  const copyCount = Math.min(sourceData.length, ARTNET_CHANNEL_COUNT);
  for (let i = 0; i < copyCount; i += 1) {
    const value = Number(sourceData[i]);
    if (!Number.isFinite(value)) continue;
    dmxData[i] = Math.max(0, Math.min(255, Math.round(value)));
  }

  const packet = Buffer.alloc(18 + ARTNET_CHANNEL_COUNT, 0);
  packet.write('Art-Net\0', 0, 'ascii');
  packet.writeUInt16LE(0x5000, 8);
  packet.writeUInt16BE(ARTNET_PROTOCOL_VERSION, 10);
  packet[12] = sequence;
  packet[13] = 0;
  packet.writeUInt16LE(universe, 14);
  packet.writeUInt16BE(ARTNET_CHANNEL_COUNT, 16);
  dmxData.copy(packet, 18);
  return packet;
};

const sendToAllWindows = (channel, payload) => {
  BrowserWindow.getAllWindows().forEach((win) => {
    if (win?.isDestroyed()) return;
    win.webContents.send(channel, payload);
  });
};

const emitVirtualMidiStatus = (extra = {}) => {
  sendToAllWindows('midi:virtual-status', {
    status: appMidiInputPort && appMidiOutputPort ? 'ready' : 'unavailable',
    inputName: APP_MIDI_INPUT_PORT_NAME,
    outputName: APP_MIDI_OUTPUT_PORT_NAME,
    inputAvailable: Boolean(appMidiInputPort),
    outputAvailable: Boolean(appMidiOutputPort),
    timestamp: Date.now(),
    ...extra,
  });
};

const emitOscListenStatus = (status, extra = {}) => {
  sendToAllWindows('osc:listen-status', {
    status,
    port: oscListenPort,
    timestamp: Date.now(),
    ...extra,
  });
};

const emitOscControlStatus = (status, extra = {}) => {
  sendToAllWindows('osc:control-listen-status', {
    status,
    port: oscControlPort,
    timestamp: Date.now(),
    ...extra,
  });
};

const parseAudioOutputChannelsFromSystemProfiler = (stdout) => {
  const parsed = JSON.parse(stdout || '{}');
  const sections = Array.isArray(parsed?.SPAudioDataType) ? parsed.SPAudioDataType : [];
  const byLabel = {};
  let defaultOutputLabel = null;
  let defaultOutputChannels = null;

  sections.forEach((section) => {
    const items = Array.isArray(section?._items) ? section._items : [];
    items.forEach((item) => {
      const name = typeof item?._name === 'string' ? item._name.trim() : '';
      const outputChannels = Number(item?.coreaudio_device_output);
      if (!name || !Number.isFinite(outputChannels) || outputChannels <= 0) return;
      byLabel[name] = Math.max(1, Math.min(Math.round(outputChannels), 128));
      if (item?.coreaudio_default_audio_output_device === 'spaudio_yes') {
        defaultOutputLabel = name;
        defaultOutputChannels = byLabel[name];
      }
    });
  });

  if (!Number.isFinite(defaultOutputChannels) || defaultOutputChannels <= 0) {
    const first = Object.values(byLabel).find((value) => Number.isFinite(value) && value > 0);
    defaultOutputChannels = Number.isFinite(first) ? first : 2;
  }

  return {
    byLabel,
    defaultOutputLabel,
    defaultOutputChannels,
  };
};

const getAudioOutputChannels = async () => {
  const now = Date.now();
  if (now - audioOutputChannelsCache.timestamp < AUDIO_DEVICE_CACHE_TTL_MS) {
    return {
      ok: true,
      ...audioOutputChannelsCache,
    };
  }

  if (audioOutputChannelsPending) {
    return audioOutputChannelsPending;
  }

  audioOutputChannelsPending = new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve({
        ok: false,
        error: 'audio channel probe is only implemented on macOS',
        ...audioOutputChannelsCache,
      });
      return;
    }

    execFile(
      '/usr/sbin/system_profiler',
      ['SPAudioDataType', '-json'],
      { maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve({
            ok: false,
            error: error?.message || 'Failed to run system_profiler',
            ...audioOutputChannelsCache,
          });
          return;
        }
        try {
          const parsed = parseAudioOutputChannelsFromSystemProfiler(stdout);
          audioOutputChannelsCache = {
            timestamp: Date.now(),
            ...parsed,
          };
          resolve({
            ok: true,
            ...audioOutputChannelsCache,
          });
        } catch (parseError) {
          resolve({
            ok: false,
            error: parseError?.message || 'Failed to parse audio device list',
            ...audioOutputChannelsCache,
          });
        }
      }
    );
  }).finally(() => {
    audioOutputChannelsPending = null;
  });

  return audioOutputChannelsPending;
};

const readOscString = (buffer, offset) => {
  if (offset >= buffer.length) return null;
  let end = offset;
  while (end < buffer.length && buffer[end] !== 0) {
    end += 1;
  }
  if (end >= buffer.length) return null;
  const value = buffer.toString('utf8', offset, end);
  let nextOffset = end + 1;
  while (nextOffset % 4 !== 0) {
    nextOffset += 1;
  }
  if (nextOffset > buffer.length) return null;
  return { value, nextOffset };
};

const readOscArgument = (buffer, offset, typeTag) => {
  if (typeTag === 'i') {
    if (offset + 4 > buffer.length) return null;
    return { value: buffer.readInt32BE(offset), nextOffset: offset + 4 };
  }
  if (typeTag === 'f') {
    if (offset + 4 > buffer.length) return null;
    return { value: buffer.readFloatBE(offset), nextOffset: offset + 4 };
  }
  if (typeTag === 'd') {
    if (offset + 8 > buffer.length) return null;
    return { value: buffer.readDoubleBE(offset), nextOffset: offset + 8 };
  }
  if (typeTag === 'h') {
    if (offset + 8 > buffer.length) return null;
    return { value: Number(buffer.readBigInt64BE(offset)), nextOffset: offset + 8 };
  }
  if (typeTag === 's') {
    const parsed = readOscString(buffer, offset);
    if (!parsed) return null;
    return { value: parsed.value, nextOffset: parsed.nextOffset };
  }
  if (typeTag === 'T') return { value: true, nextOffset: offset };
  if (typeTag === 'F') return { value: false, nextOffset: offset };
  if (typeTag === 'N' || typeTag === 'I') return { value: null, nextOffset: offset };
  return null;
};

const decodeOscPacket = (buffer) => {
  const parsedAddress = readOscString(buffer, 0);
  if (!parsedAddress) return [];
  const address = parsedAddress.value;

  if (address === '#bundle') {
    let offset = parsedAddress.nextOffset + 8;
    if (offset > buffer.length) return [];
    const messages = [];
    while (offset + 4 <= buffer.length) {
      const elementSize = buffer.readInt32BE(offset);
      offset += 4;
      if (elementSize <= 0 || offset + elementSize > buffer.length) break;
      const element = buffer.subarray(offset, offset + elementSize);
      messages.push(...decodeOscPacket(element));
      offset += elementSize;
    }
    return messages;
  }

  const parsedTypeTags = readOscString(buffer, parsedAddress.nextOffset);
  if (!parsedTypeTags) return [{ address, args: [] }];
  const tags = parsedTypeTags.value.startsWith(',') ? parsedTypeTags.value.slice(1) : '';
  let offset = parsedTypeTags.nextOffset;
  const args = [];
  for (let i = 0; i < tags.length; i += 1) {
    const parsedArg = readOscArgument(buffer, offset, tags[i]);
    if (!parsedArg) break;
    args.push(parsedArg.value);
    offset = parsedArg.nextOffset;
  }
  return [{ address, args }];
};

const rejectOscRecorderPending = (reason) => {
  const error = new Error(reason || 'OSC recorder worker unavailable');
  oscRecorderPending.forEach(({ reject }) => {
    reject(error);
  });
  oscRecorderPending.clear();
};

const ensureOscRecorderWorker = () => {
  if (oscRecorderWorker) return oscRecorderWorker;
  const workerPath = path.join(__dirname, 'oscRecorderWorker.js');
  const worker = new Worker(workerPath);
  oscRecorderWorker = worker;

  worker.on('message', (message) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rpc-result') {
      const pending = oscRecorderPending.get(message.id);
      if (!pending) return;
      oscRecorderPending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error));
        return;
      }
      pending.resolve(message.result);
      return;
    }
    if (message.type === 'listen-status') {
      const payload = message.payload || {};
      const status = payload.status || 'stopped';
      const portValue = Number(payload.port);
      if (Number.isFinite(portValue) && portValue > 0) {
        oscListenPort = portValue;
      } else if (status === 'stopped') {
        oscListenPort = null;
      }
      emitOscListenStatus(status, payload);
    }
  });

  worker.on('error', (error) => {
    if (enableDebugLog) {
      console.error(`[OSConductor] Recorder worker error: ${error?.message || error}`);
    }
  });

  worker.on('exit', (code) => {
    if (oscRecorderWorker === worker) {
      oscRecorderWorker = null;
    }
    rejectOscRecorderPending(`OSC recorder worker exited (code ${code})`);
  });

  return worker;
};

const callOscRecorder = (method, payload = {}) => {
  const worker = ensureOscRecorderWorker();
  return new Promise((resolve, reject) => {
    const id = oscRecorderRpcId++;
    oscRecorderPending.set(id, { resolve, reject });
    try {
      worker.postMessage({
        type: 'rpc',
        id,
        method,
        payload,
      });
    } catch (error) {
      oscRecorderPending.delete(id);
      reject(error);
    }
  });
};

const closeVirtualMidiPorts = (emitStatus = true) => {
  if (appMidiInputPort) {
    try {
      appMidiInputPort.closePort();
    } catch (error) {
      // Ignore close errors.
    }
    appMidiInputPort = null;
  }
  if (appMidiOutputPort) {
    try {
      appMidiOutputPort.closePort();
    } catch (error) {
      // Ignore close errors.
    }
    appMidiOutputPort = null;
  }
  if (emitStatus) {
    emitVirtualMidiStatus({ status: 'closed' });
  }
};

const openVirtualMidiPorts = () => {
  if (!midi) {
    if (enableDebugLog) {
      console.warn('[OSConductor] MIDI library unavailable. Virtual MIDI I/O not created.');
    }
    emitVirtualMidiStatus({ status: 'unsupported' });
    return;
  }
  closeVirtualMidiPorts(false);
  try {
    const input = new midi.Input();
    input.ignoreTypes(false, false, false);
    input.on('message', (deltaTime, message) => {
      if (!Array.isArray(message)) return;
      const bytes = message
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .map((value) => Math.max(0, Math.min(255, Math.round(value))));
      if (!bytes.length) return;
      sendToAllWindows('midi:virtual-message', {
        bytes,
        deltaTime: Number(deltaTime) || 0,
        timestamp: Date.now(),
      });
    });
    input.openVirtualPort(APP_MIDI_INPUT_PORT_NAME);
    appMidiInputPort = input;
  } catch (error) {
    appMidiInputPort = null;
    if (enableDebugLog) {
      console.warn(`[OSConductor] Failed to open virtual MIDI input: ${error?.message || error}`);
    }
  }

  try {
    const output = new midi.Output();
    output.openVirtualPort(APP_MIDI_OUTPUT_PORT_NAME);
    appMidiOutputPort = output;
  } catch (error) {
    appMidiOutputPort = null;
    if (enableDebugLog) {
      console.warn(`[OSConductor] Failed to open virtual MIDI output: ${error?.message || error}`);
    }
  }
  emitVirtualMidiStatus();
};

const closeOscListener = async (emitStatus = true) => {
  try {
    const result = await callOscRecorder('stop-listener', {});
    const portValue = Number(result?.port);
    if (Number.isFinite(portValue) && portValue > 0) {
      oscListenPort = portValue;
    } else {
      oscListenPort = null;
    }
    if (emitStatus) {
      emitOscListenStatus('stopped', result || {});
    }
    return result || { ok: true, port: oscListenPort };
  } catch (error) {
    if (emitStatus) {
      emitOscListenStatus('error', { error: error?.message || 'listen stop error' });
    }
    return { ok: false, error: error?.message || 'listen stop error' };
  }
};

const startOscListener = async (portValue) => {
  try {
    const result = await callOscRecorder('start-listener', { port: portValue });
    const port = Number(result?.port);
    if (Number.isFinite(port) && port > 0) {
      oscListenPort = port;
    }
    return result;
  } catch (error) {
    const parsedPort = Number(portValue);
    const safePort = Number.isFinite(parsedPort) ? Math.min(Math.max(Math.round(parsedPort), 1), 65535) : 9001;
    emitOscListenStatus('error', { port: safePort, error: error?.message || 'listen start error' });
    return { ok: false, port: safePort, error: error?.message || 'listen start error' };
  }
};

const closeOscControlListener = async (emitStatus = true) => new Promise((resolve) => {
  if (!oscControlSocket) {
    oscControlPort = null;
    if (emitStatus) {
      emitOscControlStatus('stopped');
    }
    resolve({ ok: true, port: null });
    return;
  }

  const socket = oscControlSocket;
  oscControlSocket = null;
  try {
    socket.removeAllListeners();
    socket.close(() => {
      oscControlPort = null;
      if (emitStatus) {
        emitOscControlStatus('stopped');
      }
      resolve({ ok: true, port: null });
    });
  } catch (error) {
    oscControlPort = null;
    if (emitStatus) {
      emitOscControlStatus('stopped');
    }
    resolve({ ok: true, port: null });
  }
});

const startOscControlListener = async (portValue) => {
  const parsedPort = Number(portValue);
  const safePort = Number.isFinite(parsedPort) ? Math.min(Math.max(Math.round(parsedPort), 1), 65535) : 9002;

  if (oscControlSocket && oscControlPort === safePort) {
    emitOscControlStatus('listening', { port: safePort });
    return { ok: true, port: safePort };
  }

  await closeOscControlListener(false);
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    oscControlSocket = socket;
    let settled = false;

    socket.on('message', (msg, rinfo) => {
      const packets = decodeOscPacket(msg);
      packets.forEach((packet) => {
        const value = packet.args.find((arg) => Number.isFinite(arg));
        if (!Number.isFinite(value)) return;
        sendToAllWindows('osc:control-message', {
          address: packet.address,
          value,
          args: packet.args,
          host: rinfo.address,
          sourcePort: rinfo.port,
          listenPort: safePort,
          timestamp: Date.now(),
        });
      });
    });

    socket.on('error', (error) => {
      emitOscControlStatus('error', { port: safePort, error: error?.message || 'control listen error' });
      if (!settled) {
        settled = true;
        resolve({ ok: false, port: safePort, error: error?.message || 'control listen error' });
      }
      if (oscControlSocket === socket) {
        oscControlSocket = null;
        oscControlPort = null;
      }
    });

    socket.bind(safePort, '0.0.0.0', () => {
      oscControlPort = safePort;
      emitOscControlStatus('listening', { port: safePort });
      if (!settled) {
        settled = true;
        resolve({ ok: true, port: safePort });
      }
    });
  });
};

const resolveAppIcon = () => {
  const iconName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  return path.join(__dirname, '..', 'build', 'icons', iconName);
};

const createWindow = () => {
  const win = new BrowserWindow({
    width: 1560,
    height: 860,
    minWidth: 1200,
    minHeight: 640,
    backgroundColor: '#0f1115',
    autoHideMenuBar: true,
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (useDevServer) {
    win.loadURL('http://localhost:5170');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  }

  win.webContents.on('did-finish-load', () => {
    emitVirtualMidiStatus();
  });
};

app.whenReady().then(() => {
  ensureOscRecorderWorker();
  openVirtualMidiPorts();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('audio:get-output-channels', async () => getAudioOutputChannels());
ipcMain.handle('audio:native-status', () => nativeAudioEngine.getStatus());
ipcMain.handle('audio:native-devices', () => nativeAudioEngine.listDevices());
ipcMain.handle('audio:native-configure', (_event, payload) => {
  const sampleRate = Number(payload?.sampleRate);
  const bufferFrames = Number(payload?.bufferFrames);
  const outputChannels = Number(payload?.outputChannels);
  const explicitHint = payload?.outputHint;
  const outputHint =
    (typeof explicitHint === 'number' && Number.isFinite(explicitHint))
      ? explicitHint
      : (typeof payload?.outputLabel === 'string' && payload.outputLabel.trim()
      ? payload.outputLabel.trim()
      : (payload?.outputId || 'default'));
  return nativeAudioEngine.openOrReopenStream({
    outputHint,
    sampleRate,
    bufferFrames,
    outputChannels,
  });
});
ipcMain.handle('audio:native-set-tracks', (_event, payload) => {
  return nativeAudioEngine.setTracks(Array.isArray(payload?.tracks) ? payload.tracks : []);
});
ipcMain.handle('audio:native-update-track-mix', (_event, payload) => {
  return nativeAudioEngine.updateTrackMix(Array.isArray(payload?.tracks) ? payload.tracks : []);
});
ipcMain.handle('audio:native-play', (_event, payload) => {
  return nativeAudioEngine.play(Number(payload?.playhead));
});
ipcMain.handle('audio:native-pause', () => nativeAudioEngine.pause());
ipcMain.handle('audio:native-seek', (_event, payload) => {
  return nativeAudioEngine.setPlayhead(Number(payload?.playhead));
});
ipcMain.handle('audio:native-cache-file', (_event, payload) => {
  try {
    const rawName = typeof payload?.name === 'string' && payload.name.trim()
      ? payload.name.trim()
      : 'audio.wav';
    const safeName = rawName.replace(/[^\w.\-]+/g, '_').slice(-120) || 'audio.wav';
    const rawBytes = payload?.bytes;
    const bytes = rawBytes instanceof Uint8Array
      ? rawBytes
      : (Array.isArray(rawBytes) ? Uint8Array.from(rawBytes) : null);
    if (!bytes || !bytes.length) {
      return { ok: false, error: 'No file bytes provided' };
    }
    const tempDir = path.join(app.getPath('temp'), 'osconductor-native-audio');
    fs.mkdirSync(tempDir, { recursive: true });
    const filePath = path.join(
      tempDir,
      `${Date.now()}-${Math.random().toString(16).slice(2, 8)}-${safeName}`
    );
    fs.writeFileSync(filePath, Buffer.from(bytes));
    return { ok: true, path: filePath };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to cache audio file' };
  }
});
ipcMain.handle('osc:send', async (_event, payload) => {
  const host = typeof payload?.host === 'string' && payload.host.trim() ? payload.host.trim() : '127.0.0.1';
  const port = Number(payload?.port);
  const safePort = Number.isFinite(port) ? Math.min(Math.max(Math.round(port), 1), 65535) : 9000;
  const packet = buildOscPacket(payload?.address, payload?.value, payload?.valueType);
  await new Promise((resolve, reject) => {
    oscSocket.send(packet, safePort, host, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  }).catch(() => {});
  return true;
});
ipcMain.handle('dmx:send-artnet', async (_event, payload) => {
  const host = typeof payload?.host === 'string' && payload.host.trim() ? payload.host.trim() : '127.0.0.1';
  const parsedPort = Number(payload?.port);
  const port = Number.isFinite(parsedPort)
    ? Math.min(Math.max(Math.round(parsedPort), 1), 65535)
    : ARTNET_DEFAULT_PORT;
  const packet = buildArtNetDmxPacket(payload);

  return new Promise((resolve) => {
    artNetSocket.send(packet, port, host, (error) => {
      if (error) {
        resolve({ ok: false, error: error?.message || 'Failed to send Art-Net packet' });
        return;
      }
      resolve({ ok: true });
    });
  });
});
ipcMain.handle('osc:listen-start', async (_event, payload) => startOscListener(payload?.port));
ipcMain.handle('osc:listen-stop', async () => closeOscListener(true));
ipcMain.handle('osc:control-listen-start', async (_event, payload) => startOscControlListener(payload?.port));
ipcMain.handle('osc:control-listen-stop', async () => closeOscControlListener(true));
ipcMain.handle('osc:set-recording-config', async (_event, payload) => {
  try {
    return await callOscRecorder('set-recording-config', payload || {});
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Failed to update recording config',
    };
  }
});
ipcMain.handle('osc:drain-buffer', async (_event, payload) => {
  try {
    return await callOscRecorder('drain-buffer', payload || {});
  } catch (error) {
    return {
      ok: false,
      items: [],
      remaining: 0,
      error: error?.message || 'Failed to drain OSC buffer',
    };
  }
});
ipcMain.handle('midi:virtual-send', (_event, payload) => {
  if (!appMidiOutputPort) {
    return { ok: false, error: 'Virtual MIDI output unavailable' };
  }
  const bytes = Array.isArray(payload?.bytes)
    ? payload.bytes
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
      .map((value) => Math.max(0, Math.min(255, Math.round(value))))
    : [];
  if (!bytes.length) {
    return { ok: false, error: 'No MIDI bytes provided' };
  }
  try {
    appMidiOutputPort.sendMessage(bytes);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || 'Failed to send virtual MIDI message' };
  }
});
ipcMain.handle('midi:virtual-status', () => ({
  status: appMidiInputPort && appMidiOutputPort ? 'ready' : 'unavailable',
  inputName: APP_MIDI_INPUT_PORT_NAME,
  outputName: APP_MIDI_OUTPUT_PORT_NAME,
  inputAvailable: Boolean(appMidiInputPort),
  outputAvailable: Boolean(appMidiOutputPort),
}));

app.on('before-quit', () => {
  nativeAudioEngine.shutdown();
  closeVirtualMidiPorts();
  closeOscListener(false).catch(() => {});
  closeOscControlListener(false).catch(() => {});
  if (oscRecorderWorker) {
    try {
      oscRecorderWorker.terminate();
    } catch (error) {
      // Ignore worker termination errors.
    }
    oscRecorderWorker = null;
  }
  rejectOscRecorderPending('Application is shutting down');
  try {
    oscSocket.close();
  } catch (error) {
    // Ignore socket close errors.
  }
  try {
    artNetSocket.close();
  } catch (error) {
    // Ignore socket close errors.
  }
});
