import React, { useEffect, useRef } from 'react';
import NumberInput from './NumberInput.jsx';

const parseNumber = (value, fallback) => {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
};

export default function InspectorPanel({
  track,
  selectedNode = null,
  onPatchNode,
  onPatch,
  onAddNode,
  onAudioFile,
  onOpenAudioChannelMap,
  onOpenOsc3dMonitor,
  onNameEnterNext,
  nameFocusToken,
  midiOutputOptions = [],
  oscOutputOptions = [],
  groupMemberCount = 0,
  virtualMidiOutputId = 'virtual-midi-out',
  virtualMidiOutputName = 'OSConductor MIDI OUT',
}) {
  const nameInputRef = useRef(null);
  const lastHandledNameFocusTokenRef = useRef(nameFocusToken);
  const safeMidiOutputs = Array.isArray(midiOutputOptions) ? midiOutputOptions : [];
  const safeOscOutputs = Array.isArray(oscOutputOptions) ? oscOutputOptions : [];

  useEffect(() => {
    if (!Number.isFinite(nameFocusToken) || nameFocusToken <= 0) return;
    if (nameFocusToken === lastHandledNameFocusTokenRef.current) return;
    lastHandledNameFocusTokenRef.current = nameFocusToken;
    if (!track) return;
    if (!nameInputRef.current) return;
    nameInputRef.current.focus();
    nameInputRef.current.select();
  }, [nameFocusToken]);

  if (!track) {
    return (
      <aside className="inspector">
        <div className="panel-header">
          <div className="label">Inspector</div>
        </div>
        <div className="inspector__empty">Select a track</div>
      </aside>
    );
  }

  return (
    <aside className="inspector">
      <div className="panel-header">
        <div className="label">Inspector</div>
      </div>
      <div className="inspector__content">
        <div className="inspector__section">
          <div className="inspector__title">Track</div>
          <div className="field">
            <label>Name</label>
            <input
              ref={nameInputRef}
              className="input"
              value={track.name ?? ''}
              onChange={(event) => onPatch({ name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                if (onNameEnterNext) onNameEnterNext();
              }}
            />
          </div>
          {(track.kind === 'osc' || track.kind === 'osc-array') && (
            <div className="field-grid">
              <div className="field">
                <label>Min</label>
                <NumberInput
                  className="input"
                 
                  step="0.01"
                  value={Number.isFinite(track.min) ? track.min : 0}
                  onChange={(event) => onPatch({ min: parseNumber(event.target.value, 0) })}
                />
              </div>
              <div className="field">
                <label>Max</label>
                <NumberInput
                  className="input"
                 
                  step="0.01"
                  value={Number.isFinite(track.max) ? track.max : 1}
                  onChange={(event) => onPatch({ max: parseNumber(event.target.value, 1) })}
                />
              </div>
            </div>
          )}
          {(track.kind === 'osc' || track.kind === 'osc-array' || track.kind === 'osc-flag' || track.kind === 'osc-3d') && (
            <div className="field">
              <label>Value Type</label>
              <select
                className="input"
                value={track.oscValueType === 'int' ? 'int' : 'float'}
                onChange={(event) =>
                  onPatch({
                    oscValueType: event.target.value === 'int' ? 'int' : 'float',
                  })}
              >
                <option value="int">Integer</option>
                <option value="float">Float (0.00)</option>
              </select>
            </div>
          )}
          {(track.kind === 'osc' || track.kind === 'osc-array' || track.kind === 'osc-color' || track.kind === 'osc-flag' || track.kind === 'osc-3d') && (
            <div className="field">
              <label>OSC Output</label>
              <select
                className="input"
                value={
                  typeof track.oscOutputId === 'string' && track.oscOutputId
                    ? track.oscOutputId
                    : (safeOscOutputs[0]?.id || '')
                }
                onChange={(event) => onPatch({ oscOutputId: event.target.value })}
              >
                {safeOscOutputs.map((output) => (
                  <option key={output.id} value={output.id}>
                    {output.label || `${output.name} (${output.host}:${output.port})`}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {track.kind === 'group' ? (
          <div className="inspector__section" key="group-inspector">
            <div className="inspector__title">Group</div>
            <div className="field">
              <label>State</label>
              <select
                className="input"
                value={track.group?.expanded !== false ? 'expanded' : 'collapsed'}
                onChange={(event) =>
                  onPatch({
                    group: { expanded: event.target.value === 'expanded' },
                  })}
              >
                <option value="expanded">Expanded</option>
                <option value="collapsed">Collapsed</option>
              </select>
            </div>
            <div className="inspector__row">
              <span>Member Tracks</span>
              <span className="inspector__value">{Math.max(0, Math.round(Number(groupMemberCount) || 0))}</span>
            </div>
          </div>
        ) : track.kind === 'audio' ? (
          <div className="inspector__section" key="audio-inspector">
            <div className="inspector__title">Audio</div>
            <div className="field">
              <label>Clip</label>
              <input
                className="input"
                type="file"
                accept="audio/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file && onAudioFile) onAudioFile(file);
                  event.target.value = '';
                }}
              />
            </div>
            <div className="inspector__row">
              <span>Loaded</span>
              <span className="inspector__value">{track.audio?.name || 'None'}</span>
            </div>
            <div className="field">
              <label>Volume</label>
              <input
                className="input"
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={Number.isFinite(track.audio?.volume) ? track.audio.volume : 1}
                onChange={(event) =>
                  onPatch({
                    audio: { volume: parseNumber(event.target.value, 1) },
                  })}
              />
              <div className="field__hint">
                {Number(Number.isFinite(track.audio?.volume) ? track.audio.volume : 1).toFixed(2)}
              </div>
            </div>
            <div className="inspector__buttons">
              <button
                className="btn btn--ghost"
                onClick={() => {
                  if (onOpenAudioChannelMap) onOpenAudioChannelMap(track.id);
                }}
              >
                Channel Map
              </button>
            </div>
            <div className="field__hint">
              Source channels: {Math.max(1, Math.min(Math.round(Number(track.audio?.channels) || 2), 64))}
              {' | '}
              Mapping: {track.audio?.channelMapEnabled ? 'On' : 'Off'}
            </div>
          </div>
        ) : track.kind === 'midi' ? (
          <div className="inspector__section" key="midi-cc-inspector">
            <div className="inspector__title">MIDI CC</div>
            <div className="field">
              <label>MIDI Out Port</label>
              <select
                className="input"
                value={typeof track.midi?.outputId === 'string' && track.midi.outputId
                  ? track.midi.outputId
                  : virtualMidiOutputId}
                onChange={(event) =>
                  onPatch({
                    midi: { outputId: event.target.value },
                  })}
              >
                <option value={virtualMidiOutputId}>{virtualMidiOutputName}</option>
                {safeMidiOutputs
                  .filter((device) => device.id !== virtualMidiOutputId)
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
                  value={Number.isFinite(track.midi?.channel) ? track.midi.channel : 1}
                  onChange={(event) =>
                    onPatch({
                      midi: { channel: parseNumber(event.target.value, 1) },
                    })}
                />
              </div>
              <div className="field">
                <label>CC</label>
                <NumberInput
                  className="input"
                  min="0"
                  max="127"
                  step="1"
                  value={Number.isFinite(track.midi?.controlNumber) ? track.midi.controlNumber : 1}
                  onChange={(event) =>
                    onPatch({
                      midi: { controlNumber: parseNumber(event.target.value, 1) },
                    })}
                />
              </div>
            </div>
            <div className="field__hint">
              Node values send MIDI CC values (0-127).
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'midi-note' ? (
          <div className="inspector__section" key="midi-note-inspector">
            <div className="inspector__title">MIDI Note</div>
            <div className="field">
              <label>MIDI Out Port</label>
              <select
                className="input"
                value={typeof track.midi?.outputId === 'string' && track.midi.outputId
                  ? track.midi.outputId
                  : virtualMidiOutputId}
                onChange={(event) =>
                  onPatch({
                    midi: { outputId: event.target.value },
                  })}
              >
                <option value={virtualMidiOutputId}>{virtualMidiOutputName}</option>
                {safeMidiOutputs
                  .filter((device) => device.id !== virtualMidiOutputId)
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
                  value={Number.isFinite(track.midi?.channel) ? track.midi.channel : 1}
                  onChange={(event) =>
                    onPatch({
                      midi: { channel: parseNumber(event.target.value, 1) },
                    })}
                />
              </div>
            </div>
            <div className="field__hint">
              Drag note blocks to set pitch/time. Double-click to edit time, note and length. Velocity uses track default.
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'dmx' ? (
          <div className="inspector__section" key="dmx-inspector">
            <div className="inspector__title">DMX (Art-Net)</div>
            <div className="field">
              <label>Art-Net IP</label>
              <input
                className="input input--mono"
                value={typeof track.dmx?.host === 'string' ? track.dmx.host : '127.0.0.1'}
                onChange={(event) =>
                  onPatch({
                    dmx: { host: event.target.value },
                  })}
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
                  value={Number.isFinite(track.dmx?.universe) ? track.dmx.universe : 0}
                  onChange={(event) =>
                    onPatch({
                      dmx: { universe: parseNumber(event.target.value, 0) },
                    })}
                />
              </div>
              <div className="field">
                <label>Channel</label>
                <NumberInput
                  className="input"
                 
                  min="1"
                  max="512"
                  step="1"
                  value={Number.isFinite(track.dmx?.channel) ? track.dmx.channel : 1}
                  onChange={(event) =>
                    onPatch({
                      dmx: { channel: parseNumber(event.target.value, 1) },
                    })}
                />
              </div>
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'dmx-color' ? (
          <div className="inspector__section" key="dmx-color-inspector">
            <div className="inspector__title">DMX Color (Art-Net)</div>
            <div className="field">
              <label>Art-Net IP</label>
              <input
                className="input input--mono"
                value={typeof track.dmxColor?.host === 'string' ? track.dmxColor.host : '127.0.0.1'}
                onChange={(event) =>
                  onPatch({
                    dmxColor: { host: event.target.value },
                  })}
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
                  value={Number.isFinite(track.dmxColor?.universe) ? track.dmxColor.universe : 0}
                  onChange={(event) =>
                    onPatch({
                      dmxColor: { universe: parseNumber(event.target.value, 0) },
                    })}
                />
              </div>
              <div className="field">
                <label>Channel Start</label>
                <NumberInput
                  className="input"
                 
                  min="1"
                  max="512"
                  step="1"
                  value={Number.isFinite(track.dmxColor?.channelStart) ? track.dmxColor.channelStart : 1}
                  onChange={(event) =>
                    onPatch({
                      dmxColor: { channelStart: parseNumber(event.target.value, 1) },
                    })}
                />
              </div>
            </div>
            <div className="field">
              <label>Fixture</label>
              <select
                className="input"
                value={
                  track.dmxColor?.fixtureType === 'rgbw' || track.dmxColor?.fixtureType === 'mapping'
                    ? track.dmxColor.fixtureType
                    : 'rgb'
                }
                onChange={(event) =>
                  onPatch({
                    dmxColor: {
                      fixtureType:
                        event.target.value === 'rgbw' || event.target.value === 'mapping'
                          ? event.target.value
                          : 'rgb',
                    },
                  })}
              >
                <option value="rgb">RGB</option>
                <option value="rgbw">RGBW</option>
                <option value="mapping">Channel Mapping</option>
              </select>
            </div>
            <div className="field-grid">
              <div className="field">
                <label>Gradient From</label>
                <input
                  className="input"
                  type="color"
                  value={typeof track.dmxColor?.gradientFrom === 'string' ? track.dmxColor.gradientFrom : '#000000'}
                  onChange={(event) =>
                    onPatch({
                      dmxColor: { gradientFrom: event.target.value },
                    })}
                />
              </div>
              <div className="field">
                <label>Gradient To</label>
                <input
                  className="input"
                  type="color"
                  value={typeof track.dmxColor?.gradientTo === 'string' ? track.dmxColor.gradientTo : '#000000'}
                  onChange={(event) =>
                    onPatch({
                      dmxColor: { gradientTo: event.target.value },
                    })}
                />
              </div>
            </div>
            {track.dmxColor?.fixtureType === 'mapping' && (
              <>
                <div className="field">
                  <label>RGB Mapping</label>
                  <select
                    className="input"
                    value={Number(track.dmxColor?.mappingChannels) === 3 ? '3' : '4'}
                    onChange={(event) =>
                      onPatch({
                        dmxColor: { mappingChannels: event.target.value === '3' ? 3 : 4 },
                      })}
                  >
                    <option value="3">3 Channels (RGB)</option>
                    <option value="4">4 Channels (RGBW)</option>
                  </select>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label>R Map</label>
                    <NumberInput
                      className="input"
                     
                      min="1"
                      max="512"
                      step="1"
                      value={Number.isFinite(track.dmxColor?.mapping?.r) ? track.dmxColor.mapping.r : 1}
                      onChange={(event) =>
                        onPatch({
                          dmxColor: { mapping: { r: parseNumber(event.target.value, 1) } },
                        })}
                    />
                  </div>
                  <div className="field">
                    <label>G Map</label>
                    <NumberInput
                      className="input"
                     
                      min="1"
                      max="512"
                      step="1"
                      value={Number.isFinite(track.dmxColor?.mapping?.g) ? track.dmxColor.mapping.g : 2}
                      onChange={(event) =>
                        onPatch({
                          dmxColor: { mapping: { g: parseNumber(event.target.value, 2) } },
                        })}
                    />
                  </div>
                </div>
                <div className="field-grid">
                  <div className="field">
                    <label>B Map</label>
                    <NumberInput
                      className="input"
                     
                      min="1"
                      max="512"
                      step="1"
                      value={Number.isFinite(track.dmxColor?.mapping?.b) ? track.dmxColor.mapping.b : 3}
                      onChange={(event) =>
                        onPatch({
                          dmxColor: { mapping: { b: parseNumber(event.target.value, 3) } },
                        })}
                    />
                  </div>
                  {Number(track.dmxColor?.mappingChannels) === 4 && (
                    <div className="field">
                      <label>W Map</label>
                      <NumberInput
                        className="input"
                       
                        min="1"
                        max="512"
                        step="1"
                        value={Number.isFinite(track.dmxColor?.mapping?.w) ? track.dmxColor.mapping.w : 4}
                        onChange={(event) =>
                          onPatch({
                            dmxColor: { mapping: { w: parseNumber(event.target.value, 4) } },
                          })}
                      />
                    </div>
                  )}
                </div>
                <div className="field__hint">
                  Mapping numbers are relative to Channel Start (1 = start). Select 3ch or 4ch mapping above.
                </div>
              </>
            )}
            <div className="field__hint">
              Nodes (0-255) drive position on gradient and output DMX color channels.
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'osc-color' ? (
          <div className="inspector__section" key="osc-color-inspector">
            <div className="inspector__title">OSC Color</div>
            <div className="field">
              <label>OSC Address</label>
              <input
                className="input input--mono"
                value={track.oscAddress ?? ''}
                onChange={(event) => onPatch({ oscAddress: event.target.value })}
              />
            </div>
            <div className="field">
              <label>Fixture</label>
              <select
                className="input"
                value={track.oscColor?.fixtureType === 'rgbw' ? 'rgbw' : 'rgb'}
                onChange={(event) =>
                  onPatch({
                    oscColor: {
                      fixtureType: event.target.value === 'rgbw' ? 'rgbw' : 'rgb',
                    },
                  })}
              >
                <option value="rgb">RGB</option>
                <option value="rgbw">RGBW</option>
              </select>
            </div>
            <div className="field">
              <label>Output Range</label>
              <select
                className="input"
                value={track.oscColor?.outputRange === 'unit' ? 'unit' : 'byte'}
                onChange={(event) =>
                  onPatch({
                    oscColor: {
                      outputRange: event.target.value === 'unit' ? 'unit' : 'byte',
                    },
                  })}
              >
                <option value="byte">0 to 255</option>
                <option value="unit">0 to 1</option>
              </select>
            </div>
            <div className="field__hint">
              Sends OSC array as /address r g b (or r g b w).
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'osc-array' ? (
          <div className="inspector__section" key="osc-array-inspector">
            <div className="inspector__title">OSC Array</div>
            <div className="field">
              <label>OSC Address</label>
              <input
                className="input input--mono"
                value={track.oscAddress ?? ''}
                onChange={(event) => onPatch({ oscAddress: event.target.value })}
              />
            </div>
            <div className="field">
              <label>Array Value Count</label>
              <NumberInput
                className="input"
                min="1"
                max="20"
                step="1"
                value={Number.isFinite(track.oscArray?.valueCount) ? track.oscArray.valueCount : 5}
                onChange={(event) =>
                  onPatch({
                    oscArray: {
                      valueCount: Math.min(
                        20,
                        Math.max(1, Math.round(parseNumber(event.target.value, 5)))
                      ),
                    },
                  })}
              />
            </div>
            <div className="field__hint">
              Sends /address with array values at node time. Example: /track/1/send 0 0 0 0 0
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'osc-3d' ? (
          <div className="inspector__section" key="osc-3d-inspector">
            <div className="inspector__title">3D OSC</div>
            <div className="field">
              <label>OSC Address</label>
              <input
                className="input input--mono"
                value={track.oscAddress ?? ''}
                onChange={(event) => onPatch({ oscAddress: event.target.value })}
              />
            </div>
            <div className="field">
              <label>Space Bounds</label>
              <div className="field-grid field-grid--dual">
                <div className="field">
                  <label>X Min</label>
                  <NumberInput
                    className="input"
                    step="0.01"
                    value={Number.isFinite(track.osc3d?.bounds?.xMin) ? track.osc3d.bounds.xMin : -1}
                    onChange={(event) =>
                      onPatch({
                        osc3d: { bounds: { xMin: parseNumber(event.target.value, -1) } },
                      })}
                  />
                </div>
                <div className="field">
                  <label>X Max</label>
                  <NumberInput
                    className="input"
                    step="0.01"
                    value={Number.isFinite(track.osc3d?.bounds?.xMax) ? track.osc3d.bounds.xMax : 1}
                    onChange={(event) =>
                      onPatch({
                        osc3d: { bounds: { xMax: parseNumber(event.target.value, 1) } },
                      })}
                  />
                </div>
                <div className="field">
                  <label>Y Min</label>
                  <NumberInput
                    className="input"
                    step="0.01"
                    value={Number.isFinite(track.osc3d?.bounds?.yMin) ? track.osc3d.bounds.yMin : -1}
                    onChange={(event) =>
                      onPatch({
                        osc3d: { bounds: { yMin: parseNumber(event.target.value, -1) } },
                      })}
                  />
                </div>
                <div className="field">
                  <label>Y Max</label>
                  <NumberInput
                    className="input"
                    step="0.01"
                    value={Number.isFinite(track.osc3d?.bounds?.yMax) ? track.osc3d.bounds.yMax : 1}
                    onChange={(event) =>
                      onPatch({
                        osc3d: { bounds: { yMax: parseNumber(event.target.value, 1) } },
                      })}
                  />
                </div>
                <div className="field">
                  <label>Z Min</label>
                  <NumberInput
                    className="input"
                    step="0.01"
                    value={Number.isFinite(track.osc3d?.bounds?.zMin) ? track.osc3d.bounds.zMin : -1}
                    onChange={(event) =>
                      onPatch({
                        osc3d: { bounds: { zMin: parseNumber(event.target.value, -1) } },
                      })}
                  />
                </div>
                <div className="field">
                  <label>Z Max</label>
                  <NumberInput
                    className="input"
                    step="0.01"
                    value={Number.isFinite(track.osc3d?.bounds?.zMax) ? track.osc3d.bounds.zMax : 1}
                    onChange={(event) =>
                      onPatch({
                        osc3d: { bounds: { zMax: parseNumber(event.target.value, 1) } },
                      })}
                  />
                </div>
              </div>
            </div>
            <div className="field__hint">
              Node outputs send OSC array as /address x y z. Use right click Edit Node for 3D XY / YZ controls.
            </div>
            <div className="inspector__buttons">
              <button
                className="btn btn--ghost"
                onClick={() => {
                  if (onOpenOsc3dMonitor) onOpenOsc3dMonitor(track.id);
                }}
              >
                Open 3D Monitor
              </button>
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : track.kind === 'osc-flag' ? (
          <div className="inspector__section" key="osc-flag-inspector">
            <div className="inspector__title">OSC Flag</div>
            <div className="field">
              <label>Node Address</label>
              <input
                className="input input--mono"
                value={
                  selectedNode
                    ? (typeof selectedNode.a === 'string' ? selectedNode.a : (track.oscAddress ?? ''))
                    : (track.oscAddress ?? '')
                }
                onChange={(event) => {
                  if (selectedNode && onPatchNode) {
                    onPatchNode(selectedNode.id, { a: event.target.value });
                    return;
                  }
                  onPatch({ oscAddress: event.target.value });
                }}
              />
            </div>
            {selectedNode ? (
              <>
                <div className="field">
                  <label>Trigger Time (sec)</label>
                  <NumberInput
                    className="input"
                    min="0"
                    step="0.01"
                    value={Number.isFinite(selectedNode.d) ? selectedNode.d : 1}
                    onChange={(event) => {
                      if (!onPatchNode) return;
                      onPatchNode(selectedNode.id, { d: Math.max(parseNumber(event.target.value, 1), 0) });
                    }}
                  />
                </div>
                <div className="field">
                  <label>Trigger Value</label>
                  <NumberInput
                    className="input"
                    step={track.oscValueType === 'int' ? '1' : '0.01'}
                    value={Number.isFinite(selectedNode.v) ? selectedNode.v : 1}
                    onChange={(event) => {
                      if (!onPatchNode) return;
                      const raw = parseNumber(event.target.value, 1);
                      const nextValue = track.oscValueType === 'int'
                        ? Math.round(raw)
                        : Math.round(raw * 100) / 100;
                      onPatchNode(selectedNode.id, { v: nextValue });
                    }}
                  />
                </div>
              </>
            ) : (
              <div className="field__hint">Select one flag node to edit trigger time and value.</div>
            )}
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        ) : (
          <div className="inspector__section" key="osc-inspector">
            <div className="inspector__title">OSC</div>
            <div className="field">
              <label>Address</label>
              <input
                className="input input--mono"
                value={track.oscAddress ?? ''}
                onChange={(event) => onPatch({ oscAddress: event.target.value })}
              />
            </div>
            <div className="inspector__row">
              <span>Nodes</span>
              <span className="inspector__value">{Array.isArray(track.nodes) ? track.nodes.length : 0}</span>
            </div>
          </div>
        )}
        {track.kind !== 'audio' && track.kind !== 'group' && (
          <div className="inspector__section">
            <div className="inspector__title">Actions</div>
            <div className="inspector__buttons">
              <button className="btn btn--ghost" onClick={onAddNode}>Add Node</button>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
