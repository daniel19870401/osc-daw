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
  normalizeCurveMode,
} from '../utils/easingCurves.js';

const MIDI_NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

const formatMidiNoteLabel = (value) => {
  const note = clamp(Math.round(Number(value) || 0), 0, 127);
  const name = MIDI_NOTE_NAMES[note % 12] || 'C';
  const octave = Math.floor(note / 12) - 2;
  return `${name}${octave}`;
};

export default function NodeEditor({
  track,
  view,
  height,
  width,
  curveFps = 30,
  accentColor = '#5dd8c7',
  suspendRendering = false,
  cues = [],
  isTrackSelected = false,
  externalSelectedIds = [],
  onSelectTrack,
  onNodeDrag,
  onSetNodeCurve,
  onAddNode,
  onEditNode,
  onDeleteNodes,
  onSelectionChange,
}) {
  const { nodes, min, max } = track;
  const isOscFlag = track.kind === 'osc-flag';
  const isMidiNote = track.kind === 'midi-note';
  const range = max - min || 1;
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const [selectedIds, setSelectedIds] = useState([]);
  const [draggingIds, setDraggingIds] = useState([]);
  const [selectionBox, setSelectionBox] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [snapGuide, setSnapGuide] = useState(null);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const nodeMap = useMemo(() => {
    const map = new Map();
    nodes.forEach((node) => map.set(node.id, node));
    return map;
  }, [nodes]);

  const cueTimes = useMemo(
    () => cues.map((cue) => cue.t).filter((time) => Number.isFinite(time)).sort((a, b) => a - b),
    [cues]
  );
  const contentWidth = Math.max(Number(width) || TIMELINE_WIDTH, TIMELINE_PADDING * 2 + 1);

  useEffect(() => {
    setSelectedIds((prev) => prev.filter((id) => nodeMap.has(id)));
    setDraggingIds((prev) => prev.filter((id) => nodeMap.has(id)));
  }, [nodeMap]);

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
  }, [selectedIds, onSelectionChange, track.id]);

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

  const mapValue = (v) => {
    const normalized = clamp((v - min) / range, 0, 1);
    return height - TIMELINE_PADDING - normalized * (height - 2 * TIMELINE_PADDING);
  };

  const normalizedFlagYFromPixel = (pixelY) => {
    const usableHeight = Math.max(height - TIMELINE_PADDING * 2, 1);
    return clamp((height - TIMELINE_PADDING - pixelY) / usableHeight, 0, 1);
  };

  const mapNodeY = (node) => {
    if (!isOscFlag) return mapValue(node?.v);
    const raw = Number(node?.y);
    const yNorm = Number.isFinite(raw) ? clamp(raw, 0, 1) : 0.5;
    return height - TIMELINE_PADDING - yNorm * (height - 2 * TIMELINE_PADDING);
  };

  const mapTimeToLocalX = (time) => {
    const span = Math.max(view.end - view.start, 0.0001);
    return ((time - view.start) / span) * (contentWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING;
  };

  const valueFromY = (y) => clamp(
    max - ((y - TIMELINE_PADDING) / (height - 2 * TIMELINE_PADDING)) * range,
    min,
    max
  );

  const timeFromX = (x) => {
    const span = Math.max(view.end - view.start, 0.0001);
    const time = view.start + ((x - TIMELINE_PADDING) / (contentWidth - 2 * TIMELINE_PADDING)) * span;
    return clamp(time, 0, view.length ?? view.end);
  };

  const getClosestCueTime = (time) => {
    if (!cueTimes.length) return null;
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

  const formatValue = (value) => (
    Number.isInteger(value) ? `${value}` : value.toFixed(2)
  );

  const formatOscFlagBadgeText = (node) => {
    const fallbackAddress =
      typeof track.oscAddress === 'string' && track.oscAddress.trim()
        ? track.oscAddress.trim()
        : '/osc/flag';
    const nodeAddress =
      typeof node?.a === 'string' && node.a.trim()
        ? node.a.trim()
        : fallbackAddress;
    return nodeAddress;
  };

  const displayedNodes = useMemo(() => {
    if (suspendRendering) return [];
    if (!nodes.length) return [];
    const span = Math.max(view.end - view.start, 0.0001);
    const paddedStart = view.start - span * 0.02;
    const paddedEnd = view.end + span * 0.02;

    let startIndex = 0;
    let endIndex = nodes.length - 1;

    let left = 0;
    let right = nodes.length - 1;
    while (left <= right) {
      const mid = (left + right) >> 1;
      if ((nodes[mid]?.t ?? 0) < paddedStart) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    startIndex = Math.max(left - 1, 0);

    left = startIndex;
    right = nodes.length - 1;
    while (left <= right) {
      const mid = (left + right) >> 1;
      if ((nodes[mid]?.t ?? 0) <= paddedEnd) {
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    endIndex = Math.min(left, nodes.length - 1);

    const windowNodes = nodes.slice(startIndex, endIndex + 1);
    if (!windowNodes.length) return [];

    const maxRenderable = Math.max(Math.round(contentWidth * 1.35), 480);
    if (windowNodes.length <= maxRenderable) return windowNodes;

    const selectedNeeded = new Set([...selectedIds, ...draggingIds]);
    const reduced = [];
    const step = windowNodes.length / maxRenderable;
    for (let i = 0; i < maxRenderable; i += 1) {
      reduced.push(windowNodes[Math.floor(i * step)]);
    }
    reduced.push(windowNodes[windowNodes.length - 1]);
    if (selectedNeeded.size) {
      windowNodes.forEach((node) => {
        if (selectedNeeded.has(node.id)) {
          reduced.push(node);
        }
      });
    }
    const dedup = [];
    const seen = new Set();
    reduced
      .sort((a, b) => a.t - b.t)
      .forEach((node) => {
        if (seen.has(node.id)) return;
        seen.add(node.id);
        dedup.push(node);
      });
    return dedup;
  }, [suspendRendering, nodes, view.start, view.end, contentWidth, selectedIds, draggingIds]);

  const curvePath = useMemo(() => {
    if (isMidiNote) return '';
    if (!displayedNodes.length) return '';
    if (displayedNodes.length === 1) {
      const x = mapTimeToLocalX(displayedNodes[0].t);
      const y = mapValue(displayedNodes[0].v);
      return `M ${x} ${y}`;
    }
    const commands = [];
    const firstX = mapTimeToLocalX(displayedNodes[0].t);
    const firstY = mapValue(displayedNodes[0].v);
    commands.push(`M ${firstX} ${firstY}`);
    for (let i = 0; i < displayedNodes.length - 1; i += 1) {
      const a = displayedNodes[i];
      const b = displayedNodes[i + 1];
      const ax = mapTimeToLocalX(a.t);
      const ay = mapValue(a.v);
      const bx = mapTimeToLocalX(b.t);
      const by = mapValue(b.v);
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
    return commands.join(' ');
  }, [displayedNodes, view.start, view.end, min, max, height, contentWidth, isMidiNote, curveFps]);

  const gridLines = useMemo(
    () => Array.from({ length: 9 }, (_, index) => (
      (index / 8) * (contentWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING
    )),
    [contentWidth]
  );

  const getPointerPosition = (event) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * contentWidth;
    const y = ((event.clientY - rect.top) / rect.height) * height;
    return { x, y };
  };

  const isNodeTarget = (target) => Boolean(target?.dataset?.nodeId);

  const updateSelectionByMarquee = (start, current) => {
    const x1 = Math.min(start.x, current.x);
    const x2 = Math.max(start.x, current.x);
    const y1 = Math.min(start.y, current.y);
    const y2 = Math.max(start.y, current.y);
    const selected = nodes
      .filter((node) => {
        const nx = mapTimeToLocalX(node.t);
        const ny = mapNodeY(node);
        return nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2;
      })
      .map((node) => node.id);
    setSelectedIds(selected);
    setSelectionBox({ x1, y1, x2, y2 });
  };

  const startNodeDrag = (event, nodeId) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    if (onSelectTrack) onSelectTrack(track.id);
    setContextMenu(null);

    let nextSelection = selectedIds;
    if (event.shiftKey) {
      nextSelection = selectedSet.has(nodeId)
        ? selectedIds.filter((id) => id !== nodeId)
        : [...selectedIds, nodeId];
    } else if (!selectedSet.has(nodeId)) {
      nextSelection = [nodeId];
    }
    if (!nextSelection.length) {
      nextSelection = [nodeId];
    }
    setSelectedIds(nextSelection);

    const activeIds = selectedSet.has(nodeId) && selectedIds.length > 1 && !event.shiftKey
      ? selectedIds
      : nextSelection;

    const start = getPointerPosition(event);
    const origin = {};
    activeIds.forEach((id) => {
      const node = nodeMap.get(id);
      if (!node) return;
      origin[id] = {
        t: node.t,
        v: node.v,
        y: Number.isFinite(Number(node.y)) ? clamp(Number(node.y), 0, 1) : 0.5,
      };
    });

    dragRef.current = {
      mode: 'nodes',
      start,
      startTime: timeFromX(start.x),
      startValue: isOscFlag ? normalizedFlagYFromPixel(start.y) : valueFromY(start.y),
      activeIds,
      origin,
      moved: false,
    };
    setDraggingIds(activeIds);
  };

  const startMarquee = (event) => {
    if (event.button !== 0) return;
    if (isNodeTarget(event.target)) return;
    if (onSelectTrack) onSelectTrack(track.id);
    setContextMenu(null);
    const start = getPointerPosition(event);
    dragRef.current = {
      mode: 'marquee',
      start,
      moved: false,
    };
    setSelectionBox({ x1: start.x, y1: start.y, x2: start.x, y2: start.y });
    setSelectedIds([]);
    setDraggingIds([]);
  };

  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    if (!drag) return;

    const current = getPointerPosition(event);
    const dx = Math.abs(current.x - drag.start.x);
    const dy = Math.abs(current.y - drag.start.y);
    if (!drag.moved && dx < 1.5 && dy < 1.5) return;
    drag.moved = true;

    if (drag.mode === 'nodes') {
      const deltaT = timeFromX(current.x) - drag.startTime;
      const deltaV = isOscFlag
        ? normalizedFlagYFromPixel(current.y) - drag.startValue
        : valueFromY(current.y) - drag.startValue;
      const snapTimeThreshold =
        ((view.end - view.start) / Math.max(contentWidth - TIMELINE_PADDING * 2, 1)) * 10;
      let nextSnap = null;
      drag.activeIds.forEach((id) => {
        const base = drag.origin[id];
        if (!base) return;
        const rawT = clamp(base.t + deltaT, 0, view.length ?? view.end);
        const nearestCue = getClosestCueTime(rawT);
        let t = rawT;
        if (nearestCue) {
          const shouldShowGuide = nearestCue.diff <= snapTimeThreshold || event.altKey;
          if (shouldShowGuide && nearestCue.time >= view.start && nearestCue.time <= view.end) {
            if (!nextSnap || nearestCue.diff < nextSnap.diff) {
              nextSnap = nearestCue;
            }
          }
        if (event.altKey) {
          t = clamp(nearestCue.time, 0, view.length ?? view.end);
        }
      }
        if (isOscFlag) {
          onNodeDrag(id, {
            t,
            y: clamp((Number.isFinite(base.y) ? base.y : 0.5) + deltaV, 0, 1),
          });
        } else {
          onNodeDrag(id, {
            t,
            v: clamp(base.v + deltaV, min, max),
          });
        }
      });
      setSnapGuide(nextSnap ? nextSnap.time : null);
      return;
    }

    if (drag.mode === 'marquee') {
      updateSelectionByMarquee(drag.start, current);
    }
  };

  const stopDragging = () => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === 'marquee') {
      setSelectionBox(null);
    }
    setSnapGuide(null);
    dragRef.current = null;
    setDraggingIds([]);
  };

  const handleNodeClick = (event, nodeId) => {
    event.stopPropagation();
    if (onSelectTrack) onSelectTrack(track.id);
    // Selection is resolved in pointer-down to avoid shift-click double-toggle flicker.
    if (event.shiftKey) return;
    if (!selectedSet.has(nodeId)) {
      setSelectedIds([nodeId]);
    }
  };

  const handleNodeDoubleClick = (event, node) => {
    event.preventDefault();
    event.stopPropagation();
    if (onSelectTrack) onSelectTrack(track.id);
    setSelectedIds([node.id]);
    if (onEditNode) onEditNode(node.id, node.v, isMidiNote ? 'midi-note' : 'value');
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
    if (onEditNode) onEditNode(node.id, node.v, isMidiNote ? 'midi-note' : 'value');
    setContextMenu(null);
  };

  const deleteContextNodes = () => {
    if (!contextMenu || !onDeleteNodes) return;
    const targetIds = selectedSet.has(contextMenu.nodeId) && selectedIds.length
      ? selectedIds
      : [contextMenu.nodeId];
    onDeleteNodes(targetIds);
    setSelectedIds((prev) => prev.filter((id) => !targetIds.includes(id)));
    setDraggingIds((prev) => prev.filter((id) => !targetIds.includes(id)));
    setContextMenu(null);
  };

  const handleBackgroundDoubleClick = (event) => {
    if (isNodeTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (onSelectTrack) onSelectTrack(track.id);
    const { x, y } = getPointerPosition(event);
    if (isOscFlag) {
      onAddNode({
        t: timeFromX(x),
        v: 1,
        d: 1,
        y: normalizedFlagYFromPixel(y),
        curve: 'linear',
      });
      return;
    }
    if (isMidiNote) {
      onAddNode({
        t: timeFromX(x),
        v: clamp(Math.round(valueFromY(y)), 0, 127),
        d: 0.5,
        curve: 'linear',
      });
      return;
    }
    onAddNode({
      t: timeFromX(x),
      v: valueFromY(y),
      curve: 'linear',
    });
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

  return (
    <div className="node-editor-wrap">
      <svg
        ref={svgRef}
        className="node-editor"
        viewBox={`0 0 ${contentWidth} ${height}`}
        preserveAspectRatio="none"
        style={{ '--track-accent': accentColor }}
        onPointerDown={startMarquee}
        onPointerMove={handlePointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
        onPointerLeave={stopDragging}
        onDoubleClick={handleBackgroundDoubleClick}
      >
        <rect x="0" y="0" width={contentWidth} height={height} rx="10" className="node-editor__bg" />
        {gridLines.map((x) => (
          <line
            key={x}
            x1={x}
            y1={TIMELINE_PADDING}
            x2={x}
            y2={height - TIMELINE_PADDING}
            className="node-editor__grid"
          />
        ))}
        <line
          x1={TIMELINE_PADDING}
          y1={height - TIMELINE_PADDING}
          x2={contentWidth - TIMELINE_PADDING}
          y2={height - TIMELINE_PADDING}
          className="node-editor__axis"
        />
        <line
          x1={TIMELINE_PADDING}
          y1={TIMELINE_PADDING}
          x2={contentWidth - TIMELINE_PADDING}
          y2={TIMELINE_PADDING}
          className="node-editor__axis"
        />
        {!isOscFlag && !isMidiNote && <path d={curvePath} className="node-editor__curve" />}
        {Number.isFinite(snapGuide) && (
          <line
            x1={mapTimeToLocalX(snapGuide)}
            y1={TIMELINE_PADDING}
            x2={mapTimeToLocalX(snapGuide)}
            y2={height - TIMELINE_PADDING}
            className="node-editor__snap"
          />
        )}
        {selectionBox && (
          <rect
            x={selectionBox.x1}
            y={selectionBox.y1}
            width={Math.max(selectionBox.x2 - selectionBox.x1, 0.5)}
            height={Math.max(selectionBox.y2 - selectionBox.y1, 0.5)}
            className="node-editor__marquee"
          />
        )}
        {displayedNodes.map((node) => {
          const isSelected = selectedSet.has(node.id);
          const isDragging = draggingIds.includes(node.id);
          const nodeX = mapTimeToLocalX(node.t);
          const nodeY = mapNodeY(node);
          const flagText = formatOscFlagBadgeText(node);
          const flagBodyWidth = clamp(14 + flagText.length * 6.4, 42, 320);
          const flagTipWidth = 8;
          return (
            <g
              key={node.id}
              data-selectable-node="1"
              data-track-id={track.id}
              data-node-id={node.id}
              className={`node-editor__node ${isDragging ? 'is-dragging' : ''} ${isSelected ? 'is-selected' : ''}`}
              onPointerDown={(event) => startNodeDrag(event, node.id)}
              onClick={(event) => handleNodeClick(event, node.id)}
              onDoubleClick={(event) => handleNodeDoubleClick(event, node)}
              onContextMenu={(event) => handleNodeContextMenu(event, node.id)}
            >
              {isOscFlag ? (
                <g transform={`translate(${nodeX}, ${nodeY})`} data-node-id={node.id}>
                  <rect
                    data-node-id={node.id}
                    x="-8"
                    y={TIMELINE_PADDING - nodeY}
                    width={flagBodyWidth + flagTipWidth + 12}
                    height={Math.max(height - TIMELINE_PADDING * 2, 2)}
                    className="node-editor__hit"
                  />
                  <line
                    data-node-id={node.id}
                    x1="0.8"
                    y1={TIMELINE_PADDING - nodeY}
                    x2="0.8"
                    y2={height - TIMELINE_PADDING - nodeY}
                    className="node-editor__flag-pole"
                  />
                  <path
                    data-node-id={node.id}
                    d={`M 0 -16 L ${flagBodyWidth} -16 L ${flagBodyWidth + flagTipWidth} -8 L ${flagBodyWidth} 0 L 0 0 Z`}
                    className="node-editor__flag-body"
                  />
                  <text
                    data-node-id={node.id}
                    x="6"
                    y="-8"
                    textAnchor="start"
                    dominantBaseline="middle"
                    className="node-editor__flag-text"
                  >
                    {flagText}
                  </text>
                </g>
              ) : isMidiNote ? (
                <>
                  {(() => {
                    const noteDuration = Math.max(Number(node?.d) || 0.5, 0.01);
                    const noteEnd = clamp(node.t + noteDuration, 0, view.length ?? view.end);
                    const noteWidth = Math.max(mapTimeToLocalX(noteEnd) - nodeX, 8);
                    const noteHeight = clamp(height * 0.14, 10, 18);
                    const noteY = nodeY - noteHeight / 2;
                    const noteText = `${Math.max(0, Math.min(127, Math.round(Number(node.v) || 0)))} ${formatMidiNoteLabel(node.v)}`;
                    return (
                      <>
                        <rect
                          data-node-id={node.id}
                          x={nodeX}
                          y={noteY}
                          width={noteWidth}
                          height={noteHeight}
                          rx="2"
                          className="node-editor__note"
                        />
                        <rect
                          data-node-id={node.id}
                          x={nodeX - 2}
                          y={noteY - 2}
                          width={noteWidth + 4}
                          height={noteHeight + 4}
                          className="node-editor__hit"
                        />
                        {noteWidth > 38 && (
                          <text
                            data-node-id={node.id}
                            x={nodeX + 4}
                            y={noteY + noteHeight - 3}
                            className="node-editor__note-label"
                          >
                            {noteText}
                          </text>
                        )}
                      </>
                    );
                  })()}
                </>
              ) : (
                <>
                  <circle
                    data-node-id={node.id}
                    cx={nodeX}
                    cy={nodeY}
                    r="10"
                    className="node-editor__hit"
                  />
                  <circle
                    data-node-id={node.id}
                    cx={nodeX}
                    cy={nodeY}
                    r="4.5"
                  />
                </>
              )}
            </g>
          );
        })}
        {!isOscFlag && displayedNodes.map((node) => {
          if (!selectedSet.has(node.id) && !draggingIds.includes(node.id)) return null;
          const label = isMidiNote
            ? `${Math.max(0, Math.min(127, Math.round(Number(node.v) || 0)))} ${formatMidiNoteLabel(node.v)}`
            : formatValue(node.v);
          const paddingX = 6;
          const labelWidth = label.length * 7 + paddingX * 2;
          const labelHeight = 18;
          const nodeX = mapTimeToLocalX(node.t);
          const nodeY = mapNodeY(node);
          let x = nodeX + 8;
          let y = nodeY - labelHeight - 6;
          if (x + labelWidth > contentWidth - TIMELINE_PADDING) {
            x = contentWidth - TIMELINE_PADDING - labelWidth;
          }
          if (x < TIMELINE_PADDING) x = TIMELINE_PADDING;
          if (y < TIMELINE_PADDING) y = nodeY + 8;
          return (
            <g key={`${node.id}-label`} className="node-editor__value">
              <rect x={x} y={y} width={labelWidth} height={labelHeight} rx={6} />
              <text x={x + paddingX} y={y + labelHeight - 5}>{label}</text>
            </g>
          );
        })}
        {!isOscFlag && (
          <>
            <text x={TIMELINE_PADDING} y={TIMELINE_PADDING - 4} className="node-editor__label">max {max}</text>
            <text x={TIMELINE_PADDING} y={height - 2} className="node-editor__label">min {min}</text>
          </>
        )}
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
          {!isOscFlag && !isMidiNote && <div className="node-context-menu__separator" />}
          {!isOscFlag && !isMidiNote && CURVE_MENU_ITEMS.map((item, index) => {
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
