import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TIMELINE_PADDING,
  TIMELINE_WIDTH,
  clamp,
} from '../utils/timelineMetrics.js';

const HEX_COLOR_RE = /^#([0-9a-f]{6})$/i;
const isHexColor = (value) => typeof value === 'string' && HEX_COLOR_RE.test(value);

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

const byteToHex = (value) => Math.max(0, Math.min(255, Math.round(value)))
  .toString(16)
  .padStart(2, '0');

const rgbToHex = ({ r, g, b }) => `#${byteToHex(r)}${byteToHex(g)}${byteToHex(b)}`;

const lerpColor = (from, to, t) => {
  const ratio = clamp(Number(t) || 0, 0, 1);
  return {
    r: from.r + (to.r - from.r) * ratio,
    g: from.g + (to.g - from.g) * ratio,
    b: from.b + (to.b - from.b) * ratio,
  };
};

const sampleValueAtTime = (nodes, time, fallbackValue, min, max) => {
  if (!Array.isArray(nodes) || nodes.length === 0) return clamp(fallbackValue, min, max);
  if (time <= nodes[0].t) return clamp(nodes[0].v, min, max);
  if (time >= nodes[nodes.length - 1].t) return clamp(nodes[nodes.length - 1].v, min, max);
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (time >= a.t && time <= b.t) {
      if (Math.abs(b.t - a.t) < 1e-9) return clamp(b.v, min, max);
      const ratio = (time - a.t) / (b.t - a.t);
      return clamp(a.v + (b.v - a.v) * ratio, min, max);
    }
  }
  return clamp(fallbackValue, min, max);
};

const sampleHexColorAtTime = (nodes, time, fallbackColor) => {
  if (!Array.isArray(nodes) || nodes.length === 0) return fallbackColor;
  if (time <= nodes[0].t) return nodes[0].color;
  if (time >= nodes[nodes.length - 1].t) return nodes[nodes.length - 1].color;
  for (let i = 0; i < nodes.length - 1; i += 1) {
    const a = nodes[i];
    const b = nodes[i + 1];
    if (time < a.t || time > b.t) continue;
    if (Math.abs(b.t - a.t) < 1e-9) return b.color;
    const ratio = clamp((time - a.t) / (b.t - a.t), 0, 1);
    return rgbToHex(lerpColor(parseHexColor(a.color), parseHexColor(b.color), ratio));
  }
  return nodes[nodes.length - 1].color;
};

export default function DmxColorEditor({
  track,
  view,
  height,
  width,
  suspendRendering = false,
  isTrackSelected = false,
  externalSelectedIds = [],
  onSelectTrack,
  cues = [],
  onNodeDrag,
  onAddNode,
  onEditNode,
  onDeleteNodes,
  onSelectionChange,
}) {
  const colorConfig = track.kind === 'osc-color' ? (track.oscColor || {}) : (track.dmxColor || {});
  const min = Number.isFinite(track.min) ? track.min : 0;
  const max = Number.isFinite(track.max) ? track.max : 255;
  const fallbackValue = Number.isFinite(track.default) ? track.default : 0;
  const gradientFrom = typeof colorConfig?.gradientFrom === 'string' ? colorConfig.gradientFrom : '#000000';
  const gradientTo = typeof colorConfig?.gradientTo === 'string' ? colorConfig.gradientTo : '#000000';
  const fromRgb = useMemo(() => parseHexColor(gradientFrom, '#000000'), [gradientFrom]);
  const toRgb = useMemo(() => parseHexColor(gradientTo, '#000000'), [gradientTo]);
  const sortedNodes = useMemo(
    () => (Array.isArray(track.nodes) ? [...track.nodes].sort((a, b) => a.t - b.t) : []),
    [track.nodes]
  );
  const visibleNodes = useMemo(
    () => sortedNodes.filter((node) => node.t >= view.start && node.t <= view.end),
    [sortedNodes, view.start, view.end]
  );

  const [selectedIds, setSelectedIds] = useState([]);
  const [snapGuide, setSnapGuide] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const dragRef = useRef(null);
  const svgRef = useRef(null);
  const contentWidth = Math.max(Number(width) || TIMELINE_WIDTH, TIMELINE_PADDING * 2 + 1);
  const epsilon = Math.max((view.end - view.start) / Math.max(contentWidth - TIMELINE_PADDING * 2, 1), 0.0001);
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
    const next = Array.isArray(externalSelectedIds) ? externalSelectedIds : [];
    setSelectedIds((prev) => {
      const sameLength = prev.length === next.length;
      const sameNodes = sameLength && prev.every((id, index) => id === next[index]);
      if (sameNodes) return prev;
      return next;
    });
  }, [externalSelectedIds]);

  useEffect(() => {
    if (!onSelectionChange) return;
    onSelectionChange(track.id, selectedIds);
  }, [onSelectionChange, selectedIds, track.id]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const handleOutsidePointer = (event) => {
      const target = event.target;
      if (target?.closest?.('.node-context-menu')) return;
      setContextMenu(null);
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('pointerdown', handleOutsidePointer, true);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointerdown', handleOutsidePointer, true);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [contextMenu]);

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

  const valueFromY = (y) => {
    const range = Math.max(max - min, 1e-6);
    const ratio = clamp((height - TIMELINE_PADDING - y) / Math.max(height - TIMELINE_PADDING * 2, 1), 0, 1);
    return clamp(min + ratio * range, min, max);
  };

  const valueToColor = (value) => {
    const ratio = clamp((value - min) / Math.max(max - min, 1e-6), 0, 1);
    return rgbToHex(lerpColor(fromRgb, toRgb, ratio));
  };

  const resolveNodeColor = (node) => (
    isHexColor(node?.c) ? String(node.c).toLowerCase() : valueToColor(node?.v ?? fallbackValue)
  );

  const coloredNodes = useMemo(
    () => sortedNodes.map((node) => ({ ...node, color: resolveNodeColor(node) })),
    [sortedNodes, fromRgb, toRgb]
  );

  const displayPoints = useMemo(() => {
    const fallbackColor = valueToColor(fallbackValue);
    const startValue = sampleValueAtTime(sortedNodes, view.start, fallbackValue, min, max);
    const endValue = sampleValueAtTime(sortedNodes, view.end, fallbackValue, min, max);
    const startColor = sampleHexColorAtTime(coloredNodes, view.start, fallbackColor);
    const endColor = sampleHexColorAtTime(coloredNodes, view.end, fallbackColor);
    const points = [{ id: '__start__', t: view.start, v: startValue, color: startColor, virtual: true }];
    coloredNodes.forEach((node) => {
      if (node.t <= view.start || node.t >= view.end) return;
      points.push({ ...node, virtual: false });
    });
    points.push({ id: '__end__', t: view.end, v: endValue, color: endColor, virtual: true });
    return points.sort((a, b) => a.t - b.t);
  }, [fallbackValue, max, min, sortedNodes, coloredNodes, view.end, view.start, fromRgb, toRgb]);

  const segments = useMemo(() => {
    const list = [];
    for (let i = 0; i < displayPoints.length - 1; i += 1) {
      const a = displayPoints[i];
      const b = displayPoints[i + 1];
      const x1 = mapTimeToLocalX(a.t);
      const x2 = mapTimeToLocalX(b.t);
      if (x2 <= x1 + 0.2) continue;
      list.push({
        key: `${a.id}-${b.id}-${i}`,
        x1,
        x2,
        colorA: a.color,
        colorB: b.color,
        leftId: a.virtual ? null : a.id,
        rightId: b.virtual ? null : b.id,
      });
    }
    return list;
  }, [displayPoints]);

  const nodeIndexById = useMemo(() => {
    const map = new Map();
    sortedNodes.forEach((node, index) => map.set(node.id, index));
    return map;
  }, [sortedNodes]);

  const getPointerPosition = (event) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * contentWidth;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    return { x, y };
  };

  const startStopDrag = (event, node) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (onSelectTrack) onSelectTrack(track.id);
    setContextMenu(null);
    if (event.shiftKey) {
      setSelectedIds((prev) => {
        if (prev.includes(node.id)) {
          const next = prev.filter((id) => id !== node.id);
          return next.length ? next : [node.id];
        }
        return [...prev, node.id];
      });
      dragRef.current = null;
      return;
    }
    const pointer = getPointerPosition(event);
    setSelectedIds([node.id]);
    dragRef.current = {
      mode: 'stop',
      nodeId: node.id,
      startPointer: pointer,
      startTime: timeFromX(pointer.x),
      startValue: valueFromY(pointer.y),
      originT: node.t,
      originV: node.v,
    };
  };

  const handleNodeContextMenu = (event, nodeId) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedSet.has(nodeId)) {
      setSelectedIds([nodeId]);
    }
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      nodeId,
    });
  };

  const editContextNode = () => {
    if (!contextMenu) return;
    const node = sortedNodes.find((item) => item.id === contextMenu.nodeId);
    if (!node) {
      setContextMenu(null);
      return;
    }
    if (onSelectTrack) onSelectTrack(track.id);
    setSelectedIds([node.id]);
    if (onEditNode) onEditNode(node.id, node.v, 'color', resolveNodeColor(node));
    setContextMenu(null);
  };

  const deleteContextNodes = () => {
    if (!contextMenu || !onDeleteNodes) return;
    const targetIds = selectedSet.has(contextMenu.nodeId) && selectedIds.length
      ? selectedIds
      : [contextMenu.nodeId];
    onDeleteNodes(targetIds);
    setSelectedIds((prev) => prev.filter((id) => !targetIds.includes(id)));
    setContextMenu(null);
  };

  const getClosestCueTime = (time) => {
    if (!cueTimes.length || !Number.isFinite(time)) return null;
    let closest = cueTimes[0];
    let diff = Math.abs(time - closest);
    for (let i = 1; i < cueTimes.length; i += 1) {
      const candidate = cueTimes[i];
      const candidateDiff = Math.abs(time - candidate);
      if (candidateDiff < diff) {
        closest = candidate;
        diff = candidateDiff;
      }
    }
    return { time: closest, diff };
  };

  const startSegmentDrag = (event, segment) => {
    if (event.button !== 0) return;
    if (!segment.leftId || !segment.rightId) return;
    event.stopPropagation();
    if (onSelectTrack) onSelectTrack(track.id);
    const leftIndex = nodeIndexById.get(segment.leftId);
    const rightIndex = nodeIndexById.get(segment.rightId);
    if (!Number.isInteger(leftIndex) || !Number.isInteger(rightIndex)) return;
    const left = sortedNodes[leftIndex];
    const right = sortedNodes[rightIndex];
    if (!left || !right) return;
    const pointer = getPointerPosition(event);
    setSelectedIds([left.id, right.id]);
    dragRef.current = {
      mode: 'segment',
      leftId: left.id,
      rightId: right.id,
      leftIndex,
      rightIndex,
      prevTime: leftIndex > 0 ? sortedNodes[leftIndex - 1].t : 0,
      nextTime: rightIndex < sortedNodes.length - 1 ? sortedNodes[rightIndex + 1].t : (view.length ?? view.end),
      startTime: timeFromX(pointer.x),
      startValue: valueFromY(pointer.y),
      leftOriginT: left.t,
      rightOriginT: right.t,
      leftOriginV: left.v,
      rightOriginV: right.v,
    };
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;
    const pointer = getPointerPosition(event);

    if (drag.mode === 'stop') {
      const index = nodeIndexById.get(drag.nodeId);
      if (!Number.isInteger(index)) return;
      const rawT = timeFromX(pointer.x);
      const nearestCue = getClosestCueTime(rawT);
      let nextT = event.altKey && nearestCue ? nearestCue.time : rawT;
      const prev = index > 0 ? sortedNodes[index - 1] : null;
      const next = index < sortedNodes.length - 1 ? sortedNodes[index + 1] : null;
      if (prev) nextT = Math.max(nextT, prev.t + epsilon);
      if (next) nextT = Math.min(nextT, next.t - epsilon);
      onNodeDrag(drag.nodeId, { t: nextT });
      if (event.altKey && nearestCue && nearestCue.time >= view.start && nearestCue.time <= view.end) {
        setSnapGuide(nearestCue.time);
      } else {
        setSnapGuide(null);
      }
      return;
    }

    if (drag.mode === 'segment') {
      const deltaT = timeFromX(pointer.x) - drag.startTime;
      const minShift = (drag.prevTime + epsilon) - drag.leftOriginT;
      const maxShift = (drag.nextTime - epsilon) - drag.rightOriginT;
      const appliedShift = clamp(deltaT, minShift, maxShift);
      onNodeDrag(drag.leftId, {
        t: drag.leftOriginT + appliedShift,
      });
      onNodeDrag(drag.rightId, {
        t: drag.rightOriginT + appliedShift,
      });
    }
  };

  const stopDrag = () => {
    dragRef.current = null;
    setSnapGuide(null);
  };

  const handleBackgroundDoubleClick = (event) => {
    event.preventDefault();
    const target = event.target;
    if (target?.dataset?.stopHandle === '1') return;
    if (onSelectTrack) onSelectTrack(track.id);
    setContextMenu(null);
    const pointer = getPointerPosition(event);
    const fallbackColor = valueToColor(fallbackValue);
    const sampledColor = sampleHexColorAtTime(coloredNodes, timeFromX(pointer.x), fallbackColor);
    onAddNode({
      t: timeFromX(pointer.x),
      v: valueFromY(pointer.y),
      c: sampledColor,
      curve: 'linear',
    });
  };

  const gridLines = useMemo(
    () => Array.from({ length: 9 }, (_, index) => (
      (index / 8) * (contentWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING
    )),
    [contentWidth]
  );

  const trackHeight = Math.max(height - TIMELINE_PADDING * 2, 1);

  return (
    <div className="dmx-color-editor-wrap">
      <svg
        ref={svgRef}
        className="dmx-color-editor"
        viewBox={`0 0 ${contentWidth} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onPointerLeave={stopDrag}
        onDoubleClick={handleBackgroundDoubleClick}
      >
        <defs>
          {!suspendRendering && segments.map((segment, index) => (
            <linearGradient
              key={`gradient-${segment.key}`}
              id={`dmx-color-gradient-${track.id}-${index}`}
              x1="0%"
              y1="0%"
              x2="100%"
              y2="0%"
            >
              <stop offset="0%" stopColor={segment.colorA} />
              <stop offset="100%" stopColor={segment.colorB} />
            </linearGradient>
          ))}
        </defs>
        <rect
          x="0"
          y="0"
          width={contentWidth}
          height={height}
          rx="10"
          className="dmx-color-editor__bg"
        />
        {gridLines.map((x) => (
          <line
            key={`grid-${x}`}
            x1={x}
            y1={TIMELINE_PADDING}
            x2={x}
            y2={height - TIMELINE_PADDING}
            className="dmx-color-editor__grid"
          />
        ))}
        {!suspendRendering && segments.map((segment, index) => (
          <rect
            key={segment.key}
            x={segment.x1}
            y={TIMELINE_PADDING}
            width={Math.max(segment.x2 - segment.x1, 0.5)}
            height={trackHeight}
            fill={`url(#dmx-color-gradient-${track.id}-${index})`}
            className={`dmx-color-editor__segment${segment.leftId && segment.rightId ? ' is-draggable' : ''}`}
            onPointerDown={(event) => startSegmentDrag(event, segment)}
          />
        ))}
        {Number.isFinite(snapGuide) && (
          <line
            x1={mapTimeToLocalX(snapGuide)}
            y1={TIMELINE_PADDING}
            x2={mapTimeToLocalX(snapGuide)}
            y2={height - TIMELINE_PADDING}
            className="dmx-color-editor__snap"
          />
        )}
        {!suspendRendering && visibleNodes.map((node) => {
          const x = mapTimeToLocalX(node.t);
          const color = resolveNodeColor(node);
          return (
            <g
              key={node.id}
              data-selectable-node="1"
              data-track-id={track.id}
              data-node-id={node.id}
              data-stop-handle="1"
              className={`dmx-color-editor__stop${selectedSet.has(node.id) ? ' is-selected' : ''}`}
              onPointerDown={(event) => startStopDrag(event, node)}
              onContextMenu={(event) => handleNodeContextMenu(event, node.id)}
              onClick={(event) => {
                event.stopPropagation();
                if (onSelectTrack) onSelectTrack(track.id);
                if (event.shiftKey) return;
                if (!selectedSet.has(node.id)) {
                  setSelectedIds([node.id]);
                }
              }}
              onDoubleClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (onSelectTrack) onSelectTrack(track.id);
                dragRef.current = null;
                setSelectedIds([node.id]);
                if (onEditNode) onEditNode(node.id, node.v, 'color', color);
              }}
            >
              <line
                data-stop-handle="1"
                x1={x}
                y1={TIMELINE_PADDING}
                x2={x}
                y2={height - TIMELINE_PADDING}
                className="dmx-color-editor__stop-line"
              />
              <rect
                data-stop-handle="1"
                x={x - 5}
                y={height / 2 - 12}
                width="10"
                height="24"
                rx="4"
                className="dmx-color-editor__stop-handle"
                fill={color}
              />
            </g>
          );
        })}
      </svg>
      {contextMenu && (
        <div className="node-context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            className="node-context-menu__item"
            onClick={editContextNode}
          >
            Edit Node
          </button>
          <button
            className="node-context-menu__item"
            onClick={deleteContextNodes}
          >
            Delete Node
          </button>
        </div>
      )}
    </div>
  );
}
