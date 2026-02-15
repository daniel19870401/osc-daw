import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TIMELINE_PADDING,
  TIMELINE_WIDTH,
  clamp,
} from '../utils/timelineMetrics.js';

const LINE_COLORS = [
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
  '#7dd3fc',
  '#fdba74',
  '#c4b5fd',
  '#bef264',
  '#fda4af',
  '#86efac',
  '#f9a8d4',
  '#fcd34d',
  '#67e8f9',
  '#d8b4fe',
];

const getValueCount = (track) => clamp(Math.round(Number(track?.oscArray?.valueCount) || 5), 1, 20);

const normalizeNodeValues = (track, node) => {
  const count = getValueCount(track);
  const min = Number.isFinite(track?.min) ? Number(track.min) : 0;
  const max = Number.isFinite(track?.max) ? Number(track.max) : 1;
  const fallback = clamp(Number(node?.v ?? track?.default ?? 0) || 0, min, max);
  const raw = Array.isArray(node?.arr) ? node.arr : [];
  return Array.from({ length: count }, (_, index) => (
    clamp(Number(raw[index] ?? fallback) || 0, min, max)
  ));
};

const sampleValuesAtTime = (track, sortedNodes, time) => {
  const count = getValueCount(track);
  const min = Number.isFinite(track?.min) ? Number(track.min) : 0;
  const max = Number.isFinite(track?.max) ? Number(track.max) : 1;
  const defaultValue = clamp(Number(track?.default ?? 0) || 0, min, max);
  const fallback = Array.from({ length: count }, () => defaultValue);
  if (!sortedNodes.length) return fallback;
  if (time <= sortedNodes[0].t) return normalizeNodeValues(track, sortedNodes[0]);
  if (time >= sortedNodes[sortedNodes.length - 1].t) return normalizeNodeValues(track, sortedNodes[sortedNodes.length - 1]);
  for (let i = 0; i < sortedNodes.length - 1; i += 1) {
    const a = sortedNodes[i];
    const b = sortedNodes[i + 1];
    if (time < a.t || time > b.t) continue;
    const aValues = normalizeNodeValues(track, a);
    const bValues = normalizeNodeValues(track, b);
    if (Math.abs(b.t - a.t) < 1e-9) return bValues;
    const ratio = clamp((time - a.t) / (b.t - a.t), 0, 1);
    return aValues.map((value, index) => clamp(value + (bValues[index] - value) * ratio, min, max));
  }
  return normalizeNodeValues(track, sortedNodes[sortedNodes.length - 1]);
};

export default function OscArrayEditor({
  track,
  view,
  height,
  width,
  suspendRendering = false,
  isTrackSelected = false,
  cues = [],
  onNodeDrag,
  onAddNode,
  onEditNode,
  onSelectionChange,
}) {
  const sortedNodes = useMemo(
    () => (Array.isArray(track.nodes) ? [...track.nodes].sort((a, b) => a.t - b.t) : []),
    [track.nodes]
  );
  const valueCount = getValueCount(track);
  const min = Number.isFinite(track.min) ? Number(track.min) : 0;
  const max = Number.isFinite(track.max) ? Number(track.max) : 1;
  const contentWidth = Math.max(Number(width) || TIMELINE_WIDTH, TIMELINE_PADDING * 2 + 1);
  const epsilon = Math.max((view.end - view.start) / Math.max(contentWidth - TIMELINE_PADDING * 2, 1), 0.0001);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [snapGuide, setSnapGuide] = useState(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const cueTimes = useMemo(
    () => (Array.isArray(cues) ? cues : [])
      .map((cue) => Number(cue?.t))
      .filter((time) => Number.isFinite(time))
      .sort((a, b) => a - b),
    [cues]
  );

  useEffect(() => {
    const idSet = new Set(sortedNodes.map((node) => node.id));
    setSelectedIds((prev) => prev.filter((id) => idSet.has(id)));
  }, [sortedNodes]);

  useEffect(() => {
    if (isTrackSelected) return;
    setSelectedIds([]);
    setSnapGuide(null);
  }, [isTrackSelected]);

  useEffect(() => {
    if (!onSelectionChange) return;
    if (!isTrackSelected) {
      onSelectionChange(track.id, []);
      return;
    }
    onSelectionChange(track.id, selectedIds);
  }, [isTrackSelected, onSelectionChange, selectedIds, track.id]);

  const mapTimeToLocalX = (time) => {
    const span = Math.max(view.end - view.start, 0.0001);
    return ((time - view.start) / span) * (contentWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING;
  };

  const timeFromX = (x) => {
    const span = Math.max(view.end - view.start, 0.0001);
    const time = view.start + ((x - TIMELINE_PADDING) / (contentWidth - 2 * TIMELINE_PADDING)) * span;
    return clamp(time, 0, view.length ?? view.end);
  };

  const mapValueToY = (value) => {
    const range = Math.max(max - min, 1e-6);
    const ratio = clamp((value - min) / range, 0, 1);
    return height - TIMELINE_PADDING - ratio * (height - TIMELINE_PADDING * 2);
  };

  const getPointerPosition = (event) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * contentWidth;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    return { x, y };
  };

  const getClosestCueTime = (time) => {
    if (!cueTimes.length) return null;
    let closest = cueTimes[0];
    let diff = Math.abs(time - closest);
    for (let i = 1; i < cueTimes.length; i += 1) {
      const candidate = cueTimes[i];
      const nextDiff = Math.abs(time - candidate);
      if (nextDiff < diff) {
        diff = nextDiff;
        closest = candidate;
      }
    }
    return { time: closest, diff };
  };

  const beginDrag = (event, node) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedIds([node.id]);
    dragRef.current = {
      nodeId: node.id,
    };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const nodeIndex = sortedNodes.findIndex((item) => item.id === drag.nodeId);
    if (nodeIndex < 0) return;
    const pointer = getPointerPosition(event);
    const nearestCue = getClosestCueTime(timeFromX(pointer.x));
    let nextT = event.altKey && nearestCue ? nearestCue.time : timeFromX(pointer.x);
    const prevNode = nodeIndex > 0 ? sortedNodes[nodeIndex - 1] : null;
    const nextNode = nodeIndex < sortedNodes.length - 1 ? sortedNodes[nodeIndex + 1] : null;
    if (prevNode) nextT = Math.max(nextT, prevNode.t + epsilon);
    if (nextNode) nextT = Math.min(nextT, nextNode.t - epsilon);

    onNodeDrag(drag.nodeId, {
      t: nextT,
    });

    if (event.altKey && nearestCue && nearestCue.time >= view.start && nearestCue.time <= view.end) {
      setSnapGuide(nearestCue.time);
    } else {
      setSnapGuide(null);
    }
  };

  const stopDrag = () => {
    dragRef.current = null;
    setSnapGuide(null);
  };

  const handleBackgroundDoubleClick = (event) => {
    event.preventDefault();
    const target = event.target;
    if (target?.dataset?.nodeRect === '1') return;
    const pointer = getPointerPosition(event);
    const t = timeFromX(pointer.x);
    const values = sampleValuesAtTime(track, sortedNodes, t);
    onAddNode({
      t,
      v: values[0] ?? 0,
      arr: values,
      curve: 'linear',
    });
  };

  const gridLines = useMemo(
    () => Array.from({ length: 9 }, (_, index) => (
      (index / 8) * (contentWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING
    )),
    [contentWidth]
  );

  const linePaths = useMemo(() => {
    if (suspendRendering || !sortedNodes.length) return [];
    return Array.from({ length: valueCount }, (_, channelIndex) => {
      const commands = [];
      sortedNodes.forEach((node, index) => {
        const values = normalizeNodeValues(track, node);
        const x = mapTimeToLocalX(node.t);
        const y = mapValueToY(values[channelIndex]);
        commands.push(`${index === 0 ? 'M' : 'L'} ${x} ${y}`);
      });
      return {
        color: LINE_COLORS[channelIndex % LINE_COLORS.length],
        path: commands.join(' '),
        index: channelIndex,
      };
    });
  }, [mapTimeToLocalX, mapValueToY, sortedNodes, suspendRendering, track, valueCount]);

  const rectWidth = 10;
  const rectY = TIMELINE_PADDING;
  const rectHeight = Math.max(height - TIMELINE_PADDING * 2, 1);

  return (
    <div className="osc-array-editor-wrap">
      <svg
        ref={svgRef}
        className="osc-array-editor"
        viewBox={`0 0 ${contentWidth} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onPointerLeave={stopDrag}
        onDoubleClick={handleBackgroundDoubleClick}
      >
        <rect x="0" y="0" width={contentWidth} height={height} className="osc-array-editor__bg" />
        {gridLines.map((x) => (
          <line
            key={`grid-${x}`}
            x1={x}
            y1={TIMELINE_PADDING}
            x2={x}
            y2={height - TIMELINE_PADDING}
            className="osc-array-editor__grid"
          />
        ))}
        {linePaths.map((line) => (
          <path
            key={`path-${line.index}`}
            d={line.path}
            className="osc-array-editor__line"
            style={{ stroke: line.color }}
          />
        ))}
        {snapGuide !== null && (
          <line
            x1={mapTimeToLocalX(snapGuide)}
            y1={TIMELINE_PADDING}
            x2={mapTimeToLocalX(snapGuide)}
            y2={height - TIMELINE_PADDING}
            className="osc-array-editor__snap"
          />
        )}
        {!suspendRendering && sortedNodes.map((node) => {
          const x = mapTimeToLocalX(node.t);
          const isSelected = selectedSet.has(node.id);
          return (
            <g key={node.id} className={`osc-array-editor__node ${isSelected ? 'is-selected' : ''}`}>
              <rect
                x={x - rectWidth / 2}
                y={rectY}
                width={rectWidth}
                height={rectHeight}
                rx="2"
                ry="2"
                className="osc-array-editor__node-rect"
                data-node-rect="1"
                style={{ fill: 'rgba(15, 19, 28, 0.94)', stroke: LINE_COLORS[0] }}
                onPointerDown={(event) => beginDrag(event, node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedIds([node.id]);
                  if (onEditNode) onEditNode(node.id, node.v, 'osc-array');
                }}
              />
              <rect
                x={x - rectWidth}
                y={rectY}
                width={rectWidth * 2}
                height={rectHeight}
                className="osc-array-editor__hit"
                data-node-rect="1"
                onPointerDown={(event) => beginDrag(event, node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setSelectedIds([node.id]);
                  if (onEditNode) onEditNode(node.id, node.v, 'osc-array');
                }}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}
