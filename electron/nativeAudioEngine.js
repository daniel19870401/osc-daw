const fs = require('fs');
const path = require('path');

let audify = null;
try {
  audify = require('audify');
} catch (error) {
  audify = null;
}

const MAX_OUTPUT_CHANNELS = 64;
const DEFAULT_SAMPLE_RATE = 48000;
const DEFAULT_BUFFER_FRAMES = 1024;
const PREBUFFER_BLOCKS = 4;

const normalizeText = (value) => (
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

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const readFourCC = (buffer, offset) => buffer.toString('ascii', offset, offset + 4);

const parseWavBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) {
    throw new Error('Audio file is too small to be a valid WAV.');
  }
  if (readFourCC(buffer, 0) !== 'RIFF' || readFourCC(buffer, 8) !== 'WAVE') {
    throw new Error('Unsupported audio format. Native engine currently supports WAV only.');
  }

  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let blockAlign = 0;
  let dataOffset = 0;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = readFourCC(buffer, offset);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const payloadOffset = offset + 8;
    const next = payloadOffset + chunkSize + (chunkSize % 2);
    if (next > buffer.length) break;

    if (chunkId === 'fmt ') {
      if (chunkSize < 16) {
        throw new Error('Invalid WAV fmt chunk.');
      }
      formatTag = buffer.readUInt16LE(payloadOffset);
      channels = buffer.readUInt16LE(payloadOffset + 2);
      sampleRate = buffer.readUInt32LE(payloadOffset + 4);
      blockAlign = buffer.readUInt16LE(payloadOffset + 12);
      bitsPerSample = buffer.readUInt16LE(payloadOffset + 14);
    } else if (chunkId === 'data') {
      dataOffset = payloadOffset;
      dataSize = chunkSize;
      break;
    }
    offset = next;
  }

  if (!channels || !sampleRate || !bitsPerSample || !blockAlign || !dataOffset || !dataSize) {
    throw new Error('WAV metadata missing required fields.');
  }
  if (channels < 1 || channels > MAX_OUTPUT_CHANNELS) {
    throw new Error(`Unsupported WAV channel count: ${channels}.`);
  }
  if (dataOffset + dataSize > buffer.length) {
    throw new Error('WAV data chunk is truncated.');
  }

  const bytesPerSample = bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported WAV bit depth: ${bitsPerSample}.`);
  }
  if (blockAlign !== channels * bytesPerSample) {
    throw new Error('WAV block align mismatch.');
  }

  const frameCount = Math.floor(dataSize / blockAlign);
  const channelData = Array.from({ length: channels }, () => new Float32Array(frameCount));

  const readSample = (sampleOffset) => {
    if (formatTag === 3 && bitsPerSample === 32) {
      return clamp(buffer.readFloatLE(sampleOffset), -1, 1);
    }
    if (formatTag === 1 && bitsPerSample === 16) {
      return clamp(buffer.readInt16LE(sampleOffset) / 32768, -1, 1);
    }
    if (formatTag === 1 && bitsPerSample === 24) {
      const b0 = buffer[sampleOffset];
      const b1 = buffer[sampleOffset + 1];
      const b2 = buffer[sampleOffset + 2];
      let value = b0 | (b1 << 8) | (b2 << 16);
      if (value & 0x800000) value |= 0xff000000;
      return clamp(value / 8388608, -1, 1);
    }
    if (formatTag === 1 && bitsPerSample === 32) {
      return clamp(buffer.readInt32LE(sampleOffset) / 2147483648, -1, 1);
    }
    if (formatTag === 1 && bitsPerSample === 8) {
      return clamp((buffer.readUInt8(sampleOffset) - 128) / 128, -1, 1);
    }
    throw new Error(`Unsupported WAV format tag ${formatTag} / bit depth ${bitsPerSample}.`);
  };

  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataOffset + frame * blockAlign;
    for (let ch = 0; ch < channels; ch += 1) {
      channelData[ch][frame] = readSample(frameOffset + ch * bytesPerSample);
    }
  }

  return {
    sampleRate,
    channels,
    frameCount,
    duration: frameCount / Math.max(sampleRate, 1),
    channelData,
  };
};

class NativeAudioEngine {
  constructor() {
    this.available = Boolean(audify && audify.RtAudio && audify.RtAudioFormat);
    this.error = this.available ? null : 'audify module unavailable';
    this.rtAudio = this.available ? new audify.RtAudio() : null;
    this.streamOpen = false;
    this.streamRunning = false;
    this.outputDeviceId = null;
    this.outputChannels = 2;
    this.sampleRate = DEFAULT_SAMPLE_RATE;
    this.bufferFrames = DEFAULT_BUFFER_FRAMES;
    this.playing = false;
    this.playheadFrames = 0;
    this.outputVolume = 1;
    this.trackStates = [];
    this.decodedByPath = new Map();
    this.preparing = false;
  }

  getStatus() {
    return {
      ok: true,
      available: this.available,
      error: this.error,
      streamOpen: this.streamOpen,
      streamRunning: this.streamRunning,
      api: this.available && this.rtAudio ? this.rtAudio.getApi() : null,
      sampleRate: this.sampleRate,
      bufferFrames: this.bufferFrames,
      outputChannels: this.outputChannels,
    };
  }

  listDevices() {
    if (!this.available || !this.rtAudio) {
      return { ok: false, devices: [], error: this.error || 'Native audio unavailable' };
    }
    try {
      const devices = this.rtAudio.getDevices()
        .filter((device) => Number(device?.outputChannels) > 0)
        .map((device) => ({
          id: Number(device.id),
          name: String(device.name || `Output ${device.id}`),
          outputChannels: Number(device.outputChannels) || 0,
          preferredSampleRate: Number(device.preferredSampleRate) || DEFAULT_SAMPLE_RATE,
          isDefaultOutput: Boolean(device.isDefaultOutput),
        }));
      return { ok: true, devices };
    } catch (error) {
      return { ok: false, devices: [], error: error?.message || 'Failed to get devices' };
    }
  }

  closeStream() {
    if (!this.available || !this.rtAudio) return;
    try {
      if (this.streamRunning) {
        this.rtAudio.stop();
      }
    } catch (error) {
      // Ignore stop failures.
    }
    this.streamRunning = false;
    try {
      if (this.streamOpen) {
        this.rtAudio.closeStream();
      }
    } catch (error) {
      // Ignore close failures.
    }
    this.streamOpen = false;
  }

  resolveOutputDevice(outputHint) {
    const listing = this.listDevices();
    if (!listing.ok) return { id: null, channels: 2 };
    const devices = listing.devices;
    if (!devices.length) return { id: null, channels: 2 };
    const defaultId = Number(this.rtAudio.getDefaultOutputDevice());
    const defaultDevice = devices.find((device) => device.id === defaultId) || devices[0];
    if (typeof outputHint === 'number' && Number.isFinite(outputHint)) {
      const byId = devices.find((device) => device.id === outputHint);
      if (byId) return { id: byId.id, channels: byId.outputChannels || 2 };
    }
    const normalizedHint = normalizeText(outputHint);
    if (!normalizedHint || normalizedHint === 'default' || normalizedHint === 'project-default') {
      return { id: defaultDevice.id, channels: defaultDevice.outputChannels || 2 };
    }
    const hintTokens = normalizedHint.split(' ').filter(Boolean);
    const hintChannelMatch = /(^|\s)(\d+)ch(\s|$)/.exec(normalizedHint);
    const hintChannels = hintChannelMatch ? Number(hintChannelMatch[2]) : null;
    let best = null;
    let bestScore = -Infinity;
    devices.forEach((device) => {
      const normalizedName = normalizeText(device.name);
      if (!normalizedName) return;
      let score = 0;
      if (normalizedName === normalizedHint) score += 1000;
      if (normalizedName.includes(normalizedHint) || normalizedHint.includes(normalizedName)) score += 300;
      const hitCount = hintTokens.reduce(
        (sum, token) => (token && normalizedName.includes(token) ? sum + 1 : sum),
        0
      );
      score += hitCount * 40;
      if (Number.isFinite(hintChannels)) {
        if (normalizedName.includes(`${hintChannels}ch`)) {
          score += 250;
        } else {
          score -= 100;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = device;
      }
    });
    if (best && bestScore > 0) {
      return { id: best.id, channels: best.outputChannels || 2 };
    }
    return { id: defaultDevice.id, channels: defaultDevice.outputChannels || 2 };
  }

  openOrReopenStream({ outputHint, sampleRate, bufferFrames, outputChannels }) {
    if (!this.available || !this.rtAudio) return { ok: false, error: this.error || 'Native audio unavailable' };
    const targetSampleRate = clamp(Math.round(Number(sampleRate) || DEFAULT_SAMPLE_RATE), 8000, 192000);
    const targetBufferFrames = clamp(Math.round(Number(bufferFrames) || DEFAULT_BUFFER_FRAMES), 128, 16384);
    const resolved = this.resolveOutputDevice(outputHint);
    if (!Number.isFinite(resolved.id)) {
      return { ok: false, error: 'No output device available' };
    }
    const deviceOutputChannels = clamp(Math.round(Number(resolved.channels) || 2), 1, MAX_OUTPUT_CHANNELS);
    const targetOutputChannels = clamp(
      Math.round(Number(outputChannels) || 2),
      1,
      Math.max(deviceOutputChannels, 1)
    );

    const needsReopen = !this.streamOpen
      || this.outputDeviceId !== resolved.id
      || this.sampleRate !== targetSampleRate
      || this.bufferFrames !== targetBufferFrames
      || this.outputChannels !== targetOutputChannels;

    if (!needsReopen) {
      return {
        ok: true,
        outputDeviceId: this.outputDeviceId,
        outputChannels: this.outputChannels,
        sampleRate: this.sampleRate,
        bufferFrames: this.bufferFrames,
      };
    }

    this.closeStream();
    this.outputDeviceId = resolved.id;
    this.outputChannels = targetOutputChannels;
    this.sampleRate = targetSampleRate;
    this.bufferFrames = targetBufferFrames;

    try {
      const actualFrameSize = this.rtAudio.openStream(
        {
          deviceId: this.outputDeviceId,
          nChannels: this.outputChannels,
          firstChannel: 0,
        },
        null,
        audify.RtAudioFormat.RTAUDIO_SINT16,
        this.sampleRate,
        this.bufferFrames,
        'OSConductor-Native',
        null,
        () => {
          if (!this.playing || !this.streamRunning) return;
          this.pumpOutput();
        },
        audify.RtAudioStreamFlags.RTAUDIO_MINIMIZE_LATENCY,
        (_type, msg) => {
          this.error = msg || 'Native audio stream error';
        }
      );
      if (Number.isFinite(actualFrameSize) && actualFrameSize > 0) {
        this.bufferFrames = Math.round(actualFrameSize);
      }
      this.streamOpen = true;
      this.error = null;
      return {
        ok: true,
        outputDeviceId: this.outputDeviceId,
        outputChannels: this.outputChannels,
        sampleRate: this.sampleRate,
        bufferFrames: this.bufferFrames,
      };
    } catch (error) {
      this.error = error?.message || 'Failed to open native audio stream';
      this.closeStream();
      return { ok: false, error: this.error };
    }
  }

  decodeTrackPath(filePath) {
    const normalized = path.resolve(String(filePath || ''));
    const cached = this.decodedByPath.get(normalized);
    if (cached) return cached;
    const content = fs.readFileSync(normalized);
    const decoded = parseWavBuffer(content);
    this.decodedByPath.set(normalized, decoded);
    return decoded;
  }

  setTracks(tracks) {
    const next = Array.isArray(tracks) ? tracks : [];
    const prepared = [];
    for (let i = 0; i < next.length; i += 1) {
      const item = next[i] || {};
      const filePath = typeof item.filePath === 'string' ? item.filePath.trim() : '';
      if (!filePath) continue;
      let decoded = null;
      try {
        decoded = this.decodeTrackPath(filePath);
      } catch (error) {
        continue;
      }
      if (!decoded) continue;
      const mapRaw = Array.isArray(item.channelMap) ? item.channelMap : [];
      const sourceChannels = clamp(Math.round(Number(item.sourceChannels) || decoded.channels), 1, decoded.channels);
      const channelMap = Array.from({ length: sourceChannels }, (_, index) => {
        const fallback = index + 1;
        const value = Math.round(Number(mapRaw[index]) || fallback);
        return clamp(value, 1, this.outputChannels);
      });
      prepared.push({
        id: item.id,
        volume: clamp(Number.isFinite(Number(item.volume)) ? Number(item.volume) : 1, 0, 2),
        enabled: Boolean(item.enabled),
        decoded,
        clipStartFrames: Math.max(Math.floor((Number(item.clipStart) || 0) * this.sampleRate), 0),
        sourceChannels,
        channelMap,
      });
    }
    this.trackStates = prepared;
    return { ok: true, loadedTracks: prepared.length };
  }

  updateTrackMix(tracks) {
    const next = Array.isArray(tracks) ? tracks : [];
    if (!next.length || !this.trackStates.length) {
      return { ok: true, updated: 0 };
    }
    const byId = new Map();
    for (let i = 0; i < next.length; i += 1) {
      const item = next[i] || {};
      if (!item.id) continue;
      byId.set(item.id, item);
    }
    if (!byId.size) return { ok: true, updated: 0 };
    let updated = 0;
    this.trackStates = this.trackStates.map((track) => {
      const patch = byId.get(track.id);
      if (!patch) return track;
      const nextVolume = clamp(
        Number.isFinite(Number(patch.volume)) ? Number(patch.volume) : track.volume,
        0,
        2
      );
      const nextEnabled = typeof patch.enabled === 'boolean' ? patch.enabled : track.enabled;
      const nextClipStartFrames = Number.isFinite(Number(patch.clipStart))
        ? Math.max(Math.floor(Number(patch.clipStart) * this.sampleRate), 0)
        : track.clipStartFrames;
      if (
        nextVolume === track.volume
        && nextEnabled === track.enabled
        && nextClipStartFrames === track.clipStartFrames
      ) {
        return track;
      }
      updated += 1;
      return {
        ...track,
        volume: nextVolume,
        enabled: nextEnabled,
        clipStartFrames: nextClipStartFrames,
      };
    });
    return { ok: true, updated };
  }

  setPlayhead(seconds) {
    const time = Math.max(Number(seconds) || 0, 0);
    this.playheadFrames = Math.floor(time * this.sampleRate);
    return { ok: true, playhead: this.playheadFrames / Math.max(this.sampleRate, 1) };
  }

  renderBlock() {
    const frameCount = this.bufferFrames;
    const outChannels = this.outputChannels;
    const mixed = new Float32Array(frameCount * outChannels);
    if (this.playing && this.trackStates.length) {
      for (let trackIndex = 0; trackIndex < this.trackStates.length; trackIndex += 1) {
        const track = this.trackStates[trackIndex];
        if (!track.enabled || !track.decoded) continue;
        const src = track.decoded;
        const resampleRatio = src.sampleRate / this.sampleRate;
        const srcMaxFrame = Math.max(src.frameCount - 1, 0);
        for (let frame = 0; frame < frameCount; frame += 1) {
          const timelineFrame = this.playheadFrames + frame;
          const trackTimelineFrame = timelineFrame - track.clipStartFrames;
          const srcPos = trackTimelineFrame * resampleRatio;
          if (srcPos < 0 || srcPos >= src.frameCount) continue;
          const base = Math.floor(srcPos);
          const next = Math.min(base + 1, srcMaxFrame);
          const frac = srcPos - base;
          const outBase = frame * outChannels;
          for (let ch = 0; ch < track.sourceChannels; ch += 1) {
            const targetOut = (track.channelMap[ch] || (ch + 1)) - 1;
            if (targetOut < 0 || targetOut >= outChannels) continue;
            const sourceBuffer = src.channelData[ch] || src.channelData[0];
            if (!sourceBuffer) continue;
            const s0 = sourceBuffer[base] || 0;
            const s1 = sourceBuffer[next] || 0;
            const sample = s0 + (s1 - s0) * frac;
            mixed[outBase + targetOut] += sample * track.volume;
          }
        }
      }
    }

    const pcm = Buffer.allocUnsafe(frameCount * outChannels * 2);
    for (let i = 0; i < mixed.length; i += 1) {
      const value = clamp(mixed[i], -1, 1);
      pcm.writeInt16LE(Math.round(value * 32767), i * 2);
    }
    if (this.playing) {
      this.playheadFrames += frameCount;
    }
    return pcm;
  }

  pumpOutput() {
    if (!this.streamOpen || !this.rtAudio) return;
    try {
      this.rtAudio.write(this.renderBlock());
    } catch (error) {
      this.error = error?.message || 'Failed to write audio buffer';
    }
  }

  play(seconds) {
    if (!this.available || !this.streamOpen || !this.rtAudio) {
      return { ok: false, error: this.error || 'Native audio stream unavailable' };
    }
    if (Number.isFinite(seconds)) {
      this.setPlayhead(seconds);
    }
    this.playing = true;
    try {
      this.rtAudio.clearOutputQueue();
    } catch (error) {
      // Ignore queue clear errors.
    }
    for (let i = 0; i < PREBUFFER_BLOCKS; i += 1) {
      this.pumpOutput();
    }
    try {
      if (!this.streamRunning) {
        this.rtAudio.start();
        this.streamRunning = true;
      }
    } catch (error) {
      this.error = error?.message || 'Failed to start native audio stream';
      this.streamRunning = false;
      return { ok: false, error: this.error };
    }
    return { ok: true };
  }

  pause() {
    this.playing = false;
    if (!this.available || !this.rtAudio) return { ok: true };
    try {
      if (this.streamRunning) {
        this.rtAudio.stop();
      }
    } catch (error) {
      // Ignore stop errors.
    }
    this.streamRunning = false;
    return { ok: true };
  }

  shutdown() {
    this.pause();
    this.closeStream();
  }
}

const createNativeAudioEngine = () => new NativeAudioEngine();

module.exports = {
  createNativeAudioEngine,
};
