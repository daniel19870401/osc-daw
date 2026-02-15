import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TIMELINE_PADDING,
  TIMELINE_WIDTH,
  clamp,
} from '../utils/timelineMetrics.js';
import {
  CURVE_MENU_ITEMS,
  formatCurveLabel,
  getCurveLut,
  getCurveValueRatioByFps,
  normalizeCurveMode,
} from '../utils/easingCurves.js';

const AXIS_META = [
  { key: 'x', color: '#58d5ff', minKey: 'xMin', maxKey: 'xMax' },
  { key: 'y', color: '#7dff8a', minKey: 'yMin', maxKey: 'yMax' },
  { key: 'z', color: '#ffb967', minKey: 'zMin', maxKey: 'zMax' },
];

const getBounds = (track) => {
  const raw = track?.osc3d?.bounds || {};
  const normalizeAxis = (rawMin, rawMax, fallbackMin, fallbackMax) => {
    const min = Number.isFinite(Number(rawMin)) ? Number(rawMin) : fallbackMin;
    const max = Number.isFinite(Number(rawMax)) ? Number(rawMax) : fallbackMax;
    if (min <= max) return { min, max };
    return { min: max, max: min };
  };
  const x = normalizeAxis(raw.xMin, raw.xMax, -1, 1);
  const y = normalizeAxis(raw.yMin, raw.yMax, -1, 1);
  const z = normalizeAxis(raw.zMin, raw.zMax, -1, 1);
  return {
    xMin: x.min,
    xMax: x.max,
    yMin: y.min,
    yMax: y.max,
    zMin: z.min,
    zMax: z.max,
  };
};

const normalizeNodeValues = (track, node) => {
  const bounds = getBounds(track);
  const raw = Array.isArray(node?.arr) ? node.arr : [];
  const fallback = [
    (bounds.xMin + bounds.xMax) * 0.5,
    Number.isFinite(Number(node?.v)) ? Number(node.v) : ((bounds.yMin + bounds.yMax) * 0.5),
    (bounds.zMin + bounds.zMax) * 0.5,
  ];
  return [
    clamp(Number.isFinite(Number(raw[0])) ? Number(raw[0]) : fallback[0], bounds.xMin, bounds.xMax),
    clamp(Number.isFinite(Number(raw[1])) ? Number(raw[1]) : fallback[1], bounds.yMin, bounds.yMax),
    clamp(Number.isFinite(Number(raw[2])) ? Number(raw[2]) : fallback[2], bounds.zMin, bounds.zMax),
  ];
};

const sampleValuesAtTime = (track, sortedNodes, time, curveFps = 30) => {
  const bounds = getBounds(track);
  const fallback = [
    (bounds.xMin + bounds.xMax) * 0.5,
    (bounds.yMin + bounds.yMax) * 0.5,
    (bounds.zMin + bounds.zMax) * 0.5,
  ];
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
    const ratio = getCurveValueRatioByFps((time - a.t) / (b.t - a.t), a.curve, curveFps);
    return [
      clamp(aValues[0] + (bValues[0] - aValues[0]) * ratio, bounds.xMin, bounds.xMax),
      clamp(aValues[1] + (bValues[1] - aValues[1]) * ratio, bounds.yMin, bounds.yMax),
      clamp(aValues[2] + (bValues[2] - aValues[2]) * ratio, bounds.zMin, bounds.zMax),
    ];
  }
  return normalizeNodeValues(track, sortedNodes[sortedNodes.length - 1]);
};

export default function Osc3dEditor({
  track,
  view,
  height,
  width,
  curveFps = 30,
  suspendRendering = false,
  isTrackSelected = false,
  externalSelectedIds = [],
  onSelectTrack,
  cues = [],
  onNodeDrag,
  onSetNodeCurve,
  onAddNode,
  onEditNode,
  onDeleteNodes,
  onSelectionChange,
}) {
  const sortedNodes = useMemo(
    () => (Array.isArray(track.nodes) ? [...track.nodes].sort((a, b) => a.t - b.t) : []),
    [track.nodes]
  );
  const bounds = useMemo(() => getBounds(track), [track]);
  const contentWidth = Math.max(Number(width) || TIMELINE_WIDTH, TIMELINE_PADDING * 2 + 1);
  const epsilon = Math.max((view.end - view.start) / Math.max(contentWidth - TIMELINE_PADDING * 2, 1), 0.0001);
  const svgRef = useRef(null);
  const dragRef = useRef(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [snapGuide, setSnapGuide] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const nodeMap = useMemo(() => {
    const map = new Map();
    sortedNodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [sortedNodes]);
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

  const mapAxisValueToY = (axisIndex, value) => {
    const axis = AXIS_META[axisIndex] || AXIS_META[1];
    const min = bounds[axis.minKey];
    const max = bounds[axis.maxKey];
    const span = Math.max(max - min, 1e-9);
    const ratio = clamp((value - min) / span, 0, 1);
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
    setSelectedIds([node.id]);
    dragRef.current = {
      nodeId: node.id,
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
    const node = nodeMap.get(contextMenu.nodeId);
    if (!node) {
      setContextMenu(null);
      return;
    }
    if (onSelectTrack) onSelectTrack(track.id);
    setSelectedIds([node.id]);
    if (onEditNode) onEditNode(node.id, node.v, 'osc-3d');
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

  const applyCurve = (curve) => {
    if (!contextMenu) return;
    const targetIds = selectedSet.has(contextMenu.nodeId) && selectedIds.length
      ? selectedIds
      : [contextMenu.nodeId];
    if (onSetNodeCurve) {
      onSetNodeCurve(targetIds, curve);
    } else {
      targetIds.forEach((id) => onNodeDrag(id, { curve }));
    }
    setContextMenu(null);
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
    if (onSelectTrack) onSelectTrack(track.id);
    setContextMenu(null);
    const pointer = getPointerPosition(event);
    const t = timeFromX(pointer.x);
    const values = sampleValuesAtTime(track, sortedNodes, t, curveFps);
    onAddNode({
      t,
      v: values[1] ?? 0,
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
    return AXIS_META.map((axis, axisIndex) => {
      const commands = [];
      const firstValues = normalizeNodeValues(track, sortedNodes[0]);
      const firstX = mapTimeToLocalX(sortedNodes[0].t);
      const firstY = mapAxisValueToY(axisIndex, firstValues[axisIndex]);
      commands.push(`M ${firstX} ${firstY}`);
      for (let i = 0; i < sortedNodes.length - 1; i += 1) {
        const a = sortedNodes[i];
        const b = sortedNodes[i + 1];
        const aValues = normalizeNodeValues(track, a);
        const bValues = normalizeNodeValues(track, b);
        const ax = mapTimeToLocalX(a.t);
        const ay = mapAxisValueToY(axisIndex, aValues[axisIndex]);
        const bx = mapTimeToLocalX(b.t);
        const by = mapAxisValueToY(axisIndex, bValues[axisIndex]);
        const mode = normalizeCurveMode(a.curve || 'linear');
        if (mode === 'none') {
          commands.push(`L ${bx} ${ay}`);
          commands.push(`L ${bx} ${by}`);
          continue;
        }
        if (mode === 'linear') {
          commands.push(`L ${bx} ${by}`);
          continue;
        }
        const lut = getCurveLut(mode, curveFps);
        const sampleCount = Math.max(Number(lut?.density) || 8, 8);
        const values = Array.isArray(lut?.values) ? lut.values : [];
        for (let step = 1; step <= sampleCount; step += 1) {
          const t = step / sampleCount;
          const curveT = values[step] ?? values[values.length - 1] ?? t;
          const x = ax + (bx - ax) * t;
          const y = ay + (by - ay) * curveT;
          commands.push(`L ${x} ${y}`);
        }
      }
      return {
        axisKey: axis.key,
        color: axis.color,
        path: commands.join(' '),
      };
    });
  }, [suspendRendering, sortedNodes, track, curveFps, contentWidth, view.start, view.end, height]);

  const rectWidth = 10;
  const rectY = TIMELINE_PADDING;
  const rectHeight = Math.max(height - TIMELINE_PADDING * 2, 1);

  return (
    <div className="osc-3d-editor-wrap">
      <svg
        ref={svgRef}
        className="osc-3d-editor"
        viewBox={`0 0 ${contentWidth} ${height}`}
        preserveAspectRatio="none"
        onPointerMove={handlePointerMove}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
        onPointerLeave={stopDrag}
        onDoubleClick={handleBackgroundDoubleClick}
      >
        <rect x="0" y="0" width={contentWidth} height={height} className="osc-3d-editor__bg" />
        {gridLines.map((x) => (
          <line
            key={`grid-${x}`}
            x1={x}
            y1={TIMELINE_PADDING}
            x2={x}
            y2={height - TIMELINE_PADDING}
            className="osc-3d-editor__grid"
          />
        ))}
        {linePaths.map((line) => (
          <path
            key={`path-${line.axisKey}`}
            d={line.path}
            className="osc-3d-editor__line"
            style={{ stroke: line.color }}
          />
        ))}
        {snapGuide !== null && (
          <line
            x1={mapTimeToLocalX(snapGuide)}
            y1={TIMELINE_PADDING}
            x2={mapTimeToLocalX(snapGuide)}
            y2={height - TIMELINE_PADDING}
            className="osc-3d-editor__snap"
          />
        )}
        {!suspendRendering && sortedNodes.map((node) => {
          const x = mapTimeToLocalX(node.t);
          const isSelected = selectedSet.has(node.id);
          return (
            <g
              key={node.id}
              data-selectable-node="1"
              data-track-id={track.id}
              data-node-id={node.id}
              className={`osc-3d-editor__node ${isSelected ? 'is-selected' : ''}`}
              onContextMenu={(event) => handleNodeContextMenu(event, node.id)}
            >
              <rect
                x={x - rectWidth / 2}
                y={rectY}
                width={rectWidth}
                height={rectHeight}
                rx="2"
                ry="2"
                className="osc-3d-editor__node-rect"
                data-node-rect="1"
                style={{ fill: 'rgba(15, 19, 28, 0.94)', stroke: AXIS_META[0].color }}
                onPointerDown={(event) => beginDrag(event, node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (onSelectTrack) onSelectTrack(track.id);
                  setSelectedIds([node.id]);
                  if (onEditNode) onEditNode(node.id, node.v, 'osc-3d');
                }}
              />
              <rect
                x={x - rectWidth}
                y={rectY}
                width={rectWidth * 2}
                height={rectHeight}
                className="osc-3d-editor__hit"
                data-node-rect="1"
                onPointerDown={(event) => beginDrag(event, node)}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (onSelectTrack) onSelectTrack(track.id);
                  setSelectedIds([node.id]);
                  if (onEditNode) onEditNode(node.id, node.v, 'osc-3d');
                }}
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
          {CURVE_MENU_ITEMS.map((item, index) => {
            if (item.separator) {
              return <div key={`sep-${index}`} className="node-context-menu__separator" />;
            }
            return (
              <button
                key={item.id}
                className="node-context-menu__item"
                onClick={() => applyCurve(item.id)}
              >
                {formatCurveLabel(item.id)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
