import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import NodeEditor from './NodeEditor.jsx';
import DmxColorEditor from './DmxColorEditor.jsx';
import OscArrayEditor from './OscArrayEditor.jsx';
import { TIMELINE_PADDING } from '../utils/timelineMetrics.js';

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
  onMoveAudioClip,
  onEditAudioClipStart,
  audioWaveform,
  cues = [],
}) {
  const isAudio = track.kind === 'audio';
  const isDmxColor = track.kind === 'dmx-color' || track.kind === 'osc-color';
  const isOscArray = track.kind === 'osc-array';
  const trackColor = typeof track.color === 'string' ? track.color : '#5dd8c7';
  const laneRef = useRef(null);
  const dragRef = useRef(null);
  const [dragClipStart, setDragClipStart] = useState(null);
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
  const clipStart = Number.isFinite(track.audio?.clipStart) ? Math.max(track.audio.clipStart, 0) : 0;
  const activeClipStart = dragClipStart !== null ? dragClipStart : clipStart;
  const clipEnd = activeClipStart + Math.max(duration, 0);
  const hasAudioClip = Boolean(track.audio?.src || track.audio?.name);
  const cueTimes = useMemo(
    () => cues
      .map((cue) => cue?.t)
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b),
    [cues]
  );
  const viewSpan = Math.max(view.end - view.start, 0.001);
  const contentWidth = Math.max(Number(timelineWidth) || 900, TIMELINE_PADDING * 2 + 1);
  const clipVisibleStart = Math.max(activeClipStart, view.start);
  const clipVisibleEnd = Math.min(clipEnd, view.end);
  const clipVisibleDuration = Math.max(clipVisibleEnd - clipVisibleStart, 0);
  const clipHasVisibleRange = clipVisibleDuration > 0;
  const mapTimeToSvgX = (time) => {
    const ratio = (time - view.start) / viewSpan;
    return ratio * (contentWidth - TIMELINE_PADDING * 2) + TIMELINE_PADDING;
  };
  const clipRectX = clipHasVisibleRange ? mapTimeToSvgX(clipVisibleStart) : 0;
  const clipRectWidth = clipHasVisibleRange ? Math.max(mapTimeToSvgX(clipVisibleEnd) - clipRectX, 1) : 0;

  const waveformLines = useMemo(() => {
    if (suspendRendering || !isAudio || !clipHasVisibleRange || peaks.length < 2 || duration <= 0) return [];
    const lineCount = Math.min(1000, Math.max(Math.floor(clipVisibleDuration * 48), 140));
    return Array.from({ length: lineCount }, (_, index) => {
      const ratio = lineCount <= 1 ? 0 : index / (lineCount - 1);
      const time = clipVisibleStart + ratio * clipVisibleDuration;
      const progress = Math.min(Math.max((time - activeClipStart) / duration, 0), 1);
      const peakIndex = Math.round(progress * (peaks.length - 1));
      const amplitude = peaks[peakIndex] ?? 0;
      const peak = Math.max(Math.min(amplitude, 1), 0);
      const shaped = Math.sqrt(peak);
      const lineHeight = Math.max(shaped * 76, 2);
      return {
        key: `${index}-${ratio}`,
        x: mapTimeToSvgX(time),
        y: 50 - lineHeight / 2,
        h: lineHeight,
      };
    });
  }, [
    suspendRendering,
    isAudio,
    clipHasVisibleRange,
    peaks,
    duration,
    clipVisibleDuration,
    clipVisibleStart,
    activeClipStart,
    contentWidth,
    view.start,
    view.end,
  ]);

  useEffect(() => {
    if (!isAudio) return;
    setDragClipStart(null);
  }, [clipStart, isAudio]);

  const findNearestCue = (time) => {
    if (!cueTimes.length) return null;
    let nearest = cueTimes[0];
    let minDiff = Math.abs(time - nearest);
    for (let i = 1; i < cueTimes.length; i += 1) {
      const candidate = cueTimes[i];
      const diff = Math.abs(time - candidate);
      if (diff < minDiff) {
        nearest = candidate;
        minDiff = diff;
      }
    }
    return nearest;
  };

  const commitClipDrag = (nextStart) => {
    if (!onMoveAudioClip || !isAudio) return;
    onMoveAudioClip(track.id, nextStart);
  };

  const handleClipDoubleClick = (event) => {
    if (!onEditAudioClipStart || !isAudio || !hasAudioClip) return;
    event.preventDefault();
    event.stopPropagation();
    onEditAudioClipStart(track.id, clipStart);
  };

  const handleClipPointerDown = (event) => {
    if (!isAudio || !hasAudioClip || !clipHasVisibleRange) return;
    if (event.button !== 0) return;
    const svg = event.currentTarget?.ownerSVGElement || laneRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const clientXToTime = (clientX) => {
      const localX = ((clientX - rect.left) / rect.width) * contentWidth;
      const clampedX = Math.min(
        Math.max(localX, TIMELINE_PADDING),
        contentWidth - TIMELINE_PADDING
      );
      const ratio = (clampedX - TIMELINE_PADDING) / Math.max(contentWidth - TIMELINE_PADDING * 2, 1);
      return view.start + ratio * viewSpan;
    };
    event.preventDefault();
    event.stopPropagation();
    const startPointerTime = clientXToTime(event.clientX);
    dragRef.current = {
      startX: event.clientX,
      startPointerTime,
      baseStart: clipStart,
      lastStart: clipStart,
    };
    setDragClipStart(clipStart);

    const onPointerMove = (moveEvent) => {
      const current = dragRef.current;
      if (!current) return;
      const pointerTime = clientXToTime(moveEvent.clientX);
      const deltaTime = pointerTime - current.startPointerTime;
      let nextStart = Math.max(current.baseStart + deltaTime, 0);
      if (moveEvent.altKey) {
        const nearestCue = findNearestCue(nextStart);
        if (Number.isFinite(nearestCue)) nextStart = nearestCue;
      }
      current.lastStart = nextStart;
      setDragClipStart(nextStart);
    };

    const onPointerEnd = () => {
      const current = dragRef.current;
      const nextStart = Number.isFinite(current?.lastStart)
        ? current.lastStart
        : (current ? Math.max(current.baseStart, 0) : clipStart);
      dragRef.current = null;
      setDragClipStart(null);
      commitClipDrag(nextStart);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
  };

  return (
    <div
      ref={laneRef}
      className={`track-lane ${isSelected ? 'is-selected' : ''} ${isAudio ? 'track-lane--audio' : ''} ${isDmxColor ? 'track-lane--dmx-color' : ''} ${isOscArray ? 'track-lane--osc-array' : ''}`}
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
          {hasAudioClip ? (
            <svg
              className="audio-lane__svg"
              viewBox={`0 0 ${contentWidth} 100`}
              preserveAspectRatio="none"
            >
              <rect x="0" y="0" width={contentWidth} height="100" className="audio-lane__bg" />
              {clipHasVisibleRange && (
                <>
                  <rect
                    x={clipRectX}
                    y="8"
                    width={clipRectWidth}
                    height="84"
                    className="audio-lane__clip"
                  />
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
                  <rect
                    x={clipRectX}
                    y="8"
                    width={clipRectWidth}
                    height="84"
                    className="audio-lane__clip-hit"
                    onPointerDown={handleClipPointerDown}
                    onDoubleClick={handleClipDoubleClick}
                  />
                </>
              )}
            </svg>
          ) : (
            <div className="audio-lane__empty">
              Load audio clip
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
      ) : isOscArray ? (
        <OscArrayEditor
          track={track}
          view={view}
          height={height}
          width={timelineWidth}
          suspendRendering={suspendRendering}
          isTrackSelected={isSelected}
          cues={cues}
          onNodeDrag={(nodeId, patch) => onNodeDrag(track.id, nodeId, patch)}
          onAddNode={(node) => onAddNode(track.id, node)}
          onEditNode={(nodeId, value, mode) => onEditNode(track.id, nodeId, value, mode)}
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
          onEditNode={(nodeId, value, mode, colorHex) => onEditNode(track.id, nodeId, value, mode, colorHex)}
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
