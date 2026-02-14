import React, { memo, useMemo } from 'react';
import NodeEditor from './NodeEditor.jsx';
import DmxColorEditor from './DmxColorEditor.jsx';

function TrackLane({
  track,
  view,
  height,
  timelineWidth,
  suspendRendering = false,
  isSelected,
  onSelect,
  onNodeDrag,
  onAddNode,
  onEditNode,
  onSelectionChange,
  audioWaveform,
  cues = [],
}) {
  const isAudio = track.kind === 'audio';
  const isDmxColor = track.kind === 'dmx-color';
  const trackColor = typeof track.color === 'string' ? track.color : '#5dd8c7';
  const peaks = Array.isArray(audioWaveform?.peaks)
    ? audioWaveform.peaks
    : (Array.isArray(track.audio?.waveformPeaks) ? track.audio.waveformPeaks : []);
  const duration = Number.isFinite(audioWaveform?.duration) && audioWaveform.duration > 0
    ? audioWaveform.duration
    : (Number.isFinite(track.audio?.waveformDuration) && track.audio.waveformDuration > 0
      ? track.audio.waveformDuration
    : (Number.isFinite(track.audio?.duration) && track.audio.duration > 0
      ? track.audio.duration
      : (Number.isFinite(view.length) && view.length > 0 ? view.length : 1)));
  const waveformLines = useMemo(() => {
    if (suspendRendering || !isAudio || peaks.length < 2) return [];
    const span = Math.max(view.end - view.start, 0.001);
    const lineCount = Math.min(1000, Math.max(Math.floor(span * 24), 220));
    return Array.from({ length: lineCount }, (_, index) => {
      const ratio = lineCount <= 1 ? 0 : index / (lineCount - 1);
      const time = view.start + ratio * span;
      const progress = Math.min(Math.max(time / duration, 0), 1);
      const peakIndex = Math.round(progress * (peaks.length - 1));
      const amplitude = time <= duration ? peaks[peakIndex] ?? 0 : 0;
      const peak = Math.max(Math.min(amplitude, 1), 0);
      const shaped = Math.sqrt(peak);
      const lineHeight = Math.max(shaped * 76, 2);
      return {
        key: `${index}-${ratio}`,
        x: ratio * 1000,
        y: 50 - lineHeight / 2,
        h: lineHeight,
      };
    });
  }, [suspendRendering, isAudio, peaks, duration, view.start, view.end]);

  return (
    <div
      className={`track-lane ${isSelected ? 'is-selected' : ''} ${isAudio ? 'track-lane--audio' : ''} ${isDmxColor ? 'track-lane--dmx-color' : ''}`}
      style={{ height, '--track-accent': trackColor }}
      onClick={() => onSelect(track.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSelect(track.id);
      }}
    >
      {isAudio ? (
        <div className="audio-lane" style={{ '--track-accent': trackColor }}>
          {waveformLines.length ? (
            <svg
              className="audio-lane__svg"
              viewBox="0 0 1000 100"
              preserveAspectRatio="none"
            >
              <rect x="0" y="0" width="1000" height="100" className="audio-lane__bg" />
              {waveformLines.map((line) => (
                <line
                  key={line.key}
                  x1={line.x}
                  y1={line.y}
                  x2={line.x}
                  y2={line.y + line.h}
                  className="audio-lane__line"
                />
              ))}
            </svg>
          ) : (
            <div className="audio-lane__empty">
              {track.audio?.src || track.audio?.name ? 'Processing waveform...' : 'Load audio clip'}
            </div>
          )}
        </div>
      ) : isDmxColor ? (
        <DmxColorEditor
          track={track}
          view={view}
          height={height}
          width={timelineWidth}
          accentColor={trackColor}
          suspendRendering={suspendRendering}
          isTrackSelected={isSelected}
          cues={cues}
          onNodeDrag={(nodeId, patch) => onNodeDrag(track.id, nodeId, patch)}
          onAddNode={(node) => onAddNode(track.id, node)}
          onEditNode={(nodeId, value, mode, colorHex) => onEditNode(track.id, nodeId, value, mode, colorHex)}
          onSelectionChange={onSelectionChange}
        />
      ) : (
        <NodeEditor
          track={track}
          view={view}
          height={height}
          width={timelineWidth}
          accentColor={trackColor}
          suspendRendering={suspendRendering}
          isTrackSelected={isSelected}
          cues={cues}
          onNodeDrag={(nodeId, patch) => onNodeDrag(track.id, nodeId, patch)}
          onAddNode={(node) => onAddNode(track.id, node)}
          onEditNode={(nodeId, value) => onEditNode(track.id, nodeId, value)}
          onSelectionChange={onSelectionChange}
        />
      )}
    </div>
  );
}

export default memo(TrackLane, (prev, next) => (
  prev.track === next.track
  && prev.view === next.view
  && prev.height === next.height
  && prev.timelineWidth === next.timelineWidth
  && prev.suspendRendering === next.suspendRendering
  && prev.isSelected === next.isSelected
  && prev.audioWaveform === next.audioWaveform
  && prev.cues === next.cues
));
