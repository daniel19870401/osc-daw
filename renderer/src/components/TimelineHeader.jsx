import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  TIMELINE_PADDING,
  clamp,
  formatTimecode,
} from '../utils/timelineMetrics.js';

export default function TimelineHeader({
  view,
  fps,
  playhead,
  width,
  onSeek,
  onScroll,
  cues = [],
  onCueEdit,
  onCueAdd,
  onCueMove,
  onCueDelete,
  loopEnabled = false,
  loopStart = 0,
  loopEnd = 0,
  onLoopRangeChange,
  onLoopEdit,
}) {
  const TIMELINE_HEADER_HEIGHT = 72;
  const TICK_TOP = 24;
  const TICK_BOTTOM = 44;
  const BASELINE_Y = 52;
  const CUE_TOP = 34;
  const CUE_BOTTOM = 58;
  const CUE_DOT_Y = 44;
  const CUE_MARKER_HALF = 11;
  const LOOP_TICK_SELECTION_TOP = 20;
  const LOOP_TICK_SELECTION_BOTTOM = 52;
  const LOOP_AUTOSCROLL_EDGE_PX = 28;
  const LOOP_AUTOSCROLL_FACTOR = 0.05;
  const MIN_LOOP_SPAN = 1 / Math.max(Number(fps) || 30, 1);
  const svgRef = useRef(null);
  const cueDragRef = useRef(null);
  const loopDragRef = useRef(null);
  const viewStateRef = useRef({
    start: Number(view.start) || 0,
    end: Number(view.end) || 0,
    length: Number(view.length) || 0,
  });
  const [cueMenu, setCueMenu] = useState(null);
  const timelineWidth = Number(width) || 900;
  const svgWidth = Math.max(timelineWidth, TIMELINE_PADDING * 2 + 1);
  const duration = view.end - view.start;
  const safeFps = Math.max(Number(fps) || 30, 1);
  const frameDuration = 1 / safeFps;

  const mapTimeToLocalX = (time) => {
    const span = Math.max(duration || 0, 0.0001);
    return ((time - view.start) / span) * (svgWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING;
  };

  const mapLocalXToTime = (x) => {
    const span = Math.max(duration || 0, 0.0001);
    return view.start + ((x - TIMELINE_PADDING) / (svgWidth - 2 * TIMELINE_PADDING)) * span;
  };

  const majorStep = useMemo(() => {
    const target = Math.max(duration / Math.max(Math.round(timelineWidth / 130), 1), frameDuration);
    const tenFrames = frameDuration * 10;
    const candidates = [
      tenFrames,
      tenFrames * 2,
      tenFrames * 5,
      0.5,
      1,
      2,
      5,
      10,
      20,
      30,
      60,
      120,
      300,
      600,
      1200,
    ].filter((step, index, array) => step >= frameDuration && array.indexOf(step) === index)
      .sort((a, b) => a - b);
    return candidates.find((step) => step >= target) || candidates[candidates.length - 1];
  }, [duration, timelineWidth, frameDuration]);

  const minorStep = useMemo(() => {
    const divisors = [10, 5, 2];
    for (let i = 0; i < divisors.length; i += 1) {
      const step = majorStep / divisors[i];
      if (step >= frameDuration) return step;
    }
    return majorStep;
  }, [majorStep, frameDuration]);

  const buildTicks = (step) => {
    if (!Number.isFinite(step) || step <= 0) return [];
    const epsilon = step * 0.0001;
    const first = Math.ceil((view.start - epsilon) / step) * step;
    const values = [];
    for (let t = first; t <= view.end + epsilon; t += step) {
      const rounded = Math.round(t / step) * step;
      values.push(clamp(rounded, view.start, view.end));
      if (values.length > 4000) break;
    }
    if (!values.length || values[0] > view.start + epsilon) values.unshift(view.start);
    if (values[values.length - 1] < view.end - epsilon) values.push(view.end);
    return values;
  };

  const majorTicks = useMemo(() => buildTicks(majorStep), [majorStep, view.start, view.end]);
  const minorTicks = useMemo(() => {
    const ticks = buildTicks(minorStep);
    const tolerance = Math.max(minorStep * 0.2, frameDuration * 0.5);
    return ticks.filter((tick) => !majorTicks.some((major) => Math.abs(major - tick) <= tolerance));
  }, [minorStep, majorTicks, frameDuration, view.start, view.end]);

  useEffect(() => {
    viewStateRef.current = {
      start: Number(view.start) || 0,
      end: Number(view.end) || 0,
      length: Number(view.length) || 0,
    };
  }, [view.start, view.end, view.length]);

  useEffect(() => {
    if (!cueMenu) return undefined;
    const closeMenu = (event) => {
      if (event.target?.closest?.('.timeline-cue-menu')) return;
      setCueMenu(null);
    };
    const handleEscape = (event) => {
      if (event.key === 'Escape') setCueMenu(null);
    };
    window.addEventListener('pointerdown', closeMenu, true);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('pointerdown', closeMenu, true);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [cueMenu]);

  const handleClick = (event) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * svgWidth;
    const time = clamp(mapLocalXToTime(x), view.start, view.end);
    onSeek(time);
  };

  const handleDoubleClick = (event) => {
    if (!onCueAdd) return;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * svgWidth;
    const time = clamp(mapLocalXToTime(x), view.start, view.end);
    onCueAdd(time);
  };

  const numberedCues = cues.map((cue, index) => ({ ...cue, number: index + 1 }));
  const visibleCues = numberedCues.filter((cue) => cue.t >= view.start && cue.t <= view.end);
  const playheadTime = clamp(typeof playhead === 'number' ? playhead : view.start, view.start, view.end);
  const playheadX = mapTimeToLocalX(playheadTime);
  const normalizedLoopStart = clamp(Number(loopStart) || 0, 0, view.length);
  let normalizedLoopEnd = clamp(Number(loopEnd) || 0, 0, view.length);
  if (normalizedLoopEnd - normalizedLoopStart < MIN_LOOP_SPAN) {
    normalizedLoopEnd = clamp(normalizedLoopStart + MIN_LOOP_SPAN, 0, view.length);
  }
  const loopStartX = mapTimeToLocalX(normalizedLoopStart);
  const loopEndX = mapTimeToLocalX(normalizedLoopEnd);
  const loopLeftPercent = (loopStartX / svgWidth) * 100;
  const loopWidthPercent = Math.max(((loopEndX - loopStartX) / svgWidth) * 100, 0);
  const loopPaddingPercent = (TIMELINE_PADDING / svgWidth) * 100;

  const beginCueDrag = (event, cue) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    setCueMenu(null);
    if (svgRef.current?.setPointerCapture) {
      svgRef.current.setPointerCapture(event.pointerId);
    }
    cueDragRef.current = {
      cueId: cue.id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
    };
  };

  const updateCueDrag = (event) => {
    if (!cueDragRef.current || !svgRef.current || !onCueMove) return;
    const dx = Math.abs(event.clientX - cueDragRef.current.startX);
    const dy = Math.abs(event.clientY - cueDragRef.current.startY);
    if (!cueDragRef.current.moved && dx < 2 && dy < 2) return;
    cueDragRef.current.moved = true;
    const rect = svgRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * svgWidth;
    const time = clamp(mapLocalXToTime(x), view.start, view.end);
    onCueMove(cueDragRef.current.cueId, time);
  };

  const endCueDrag = () => {
    if (cueDragRef.current?.pointerId && svgRef.current?.releasePointerCapture) {
      try {
        svgRef.current.releasePointerCapture(cueDragRef.current.pointerId);
      } catch (error) {
        // Ignore capture release errors.
      }
    }
    cueDragRef.current = null;
  };

  const mapClientXToTime = (clientX, start, end, length) => {
    if (!svgRef.current) return normalizedLoopStart;
    const rect = svgRef.current.getBoundingClientRect();
    if (!rect.width) return normalizedLoopStart;
    const span = Math.max(end - start, MIN_LOOP_SPAN);
    const x = ((clientX - rect.left) / rect.width) * svgWidth;
    const clampedX = clamp(x, TIMELINE_PADDING, svgWidth - TIMELINE_PADDING);
    const time = start + ((clampedX - TIMELINE_PADDING) / (svgWidth - TIMELINE_PADDING * 2)) * span;
    return clamp(time, 0, length);
  };

  const beginLoopHandleDrag = (event, edge) => {
    if (!onLoopRangeChange) return;
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const initialView = viewStateRef.current;
    const pointerTime = mapClientXToTime(
      event.clientX,
      initialView.start,
      initialView.end,
      initialView.length
    );
    loopDragRef.current = {
      edge,
      pointerId: event.pointerId,
      start: normalizedLoopStart,
      end: normalizedLoopEnd,
      rangeOffset: pointerTime - normalizedLoopStart,
    };
    const onPointerMove = (moveEvent) => {
      const drag = loopDragRef.current;
      if (!drag) return;
      if (!svgRef.current) return;
      const rect = svgRef.current.getBoundingClientRect();
      if (!rect.width) return;

      let { start, end, length } = viewStateRef.current;
      const span = Math.max(end - start, MIN_LOOP_SPAN);
      const maxStart = Math.max(length - span, 0);

      if (moveEvent.clientX < rect.left + LOOP_AUTOSCROLL_EDGE_PX) {
        const ratio = clamp((rect.left + LOOP_AUTOSCROLL_EDGE_PX - moveEvent.clientX) / LOOP_AUTOSCROLL_EDGE_PX, 0, 1);
        const nextStart = clamp(start - span * LOOP_AUTOSCROLL_FACTOR * ratio, 0, maxStart);
        if (Math.abs(nextStart - start) > 0.0001) {
          start = nextStart;
          end = start + span;
          viewStateRef.current = { start, end, length };
          if (onScroll) onScroll(start);
        }
      } else if (moveEvent.clientX > rect.right - LOOP_AUTOSCROLL_EDGE_PX) {
        const ratio = clamp((moveEvent.clientX - (rect.right - LOOP_AUTOSCROLL_EDGE_PX)) / LOOP_AUTOSCROLL_EDGE_PX, 0, 1);
        const nextStart = clamp(start + span * LOOP_AUTOSCROLL_FACTOR * ratio, 0, maxStart);
        if (Math.abs(nextStart - start) > 0.0001) {
          start = nextStart;
          end = start + span;
          viewStateRef.current = { start, end, length };
          if (onScroll) onScroll(start);
        }
      }

      const time = mapClientXToTime(moveEvent.clientX, start, end, length);
      if (drag.edge === 'start') {
        drag.start = clamp(time, 0, drag.end - MIN_LOOP_SPAN);
      } else if (drag.edge === 'end') {
        drag.end = clamp(time, drag.start + MIN_LOOP_SPAN, length);
      } else if (drag.edge === 'range') {
        const spanLocked = Math.max(drag.end - drag.start, MIN_LOOP_SPAN);
        const maxStart = Math.max(length - spanLocked, 0);
        const anchoredStart = clamp(time - drag.rangeOffset, 0, maxStart);
        drag.start = anchoredStart;
        drag.end = clamp(anchoredStart + spanLocked, 0, length);
      }
      onLoopRangeChange({ start: drag.start, end: drag.end });
    };
    const onPointerUp = () => {
      loopDragRef.current = null;
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  return (
    <div className="timeline-scale">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${svgWidth} ${TIMELINE_HEADER_HEIGHT}`}
        preserveAspectRatio="none"
        className="timeline-scale__svg"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onPointerMove={updateCueDrag}
        onPointerUp={endCueDrag}
        onPointerCancel={endCueDrag}
        onPointerLeave={endCueDrag}
        onContextMenu={(event) => event.preventDefault()}
      >
        <rect x="0" y="0" width={svgWidth} height={TIMELINE_HEADER_HEIGHT} className="timeline-scale__bg" />
        {loopEnabled && loopWidthPercent > 0 && (
          <rect
            x={loopStartX}
            y={LOOP_TICK_SELECTION_TOP}
            width={Math.max(loopEndX - loopStartX, 1)}
            height={LOOP_TICK_SELECTION_BOTTOM - LOOP_TICK_SELECTION_TOP}
            className="timeline-loop__tick-selection"
            rx="4"
            ry="4"
          />
        )}
        {minorTicks.map((tick) => {
          const x = mapTimeToLocalX(tick);
          return (
            <g key={`minor-${tick}`}>
              <line
                x1={x}
                y1={32}
                x2={x}
                y2={TICK_BOTTOM}
                className="timeline-scale__line timeline-scale__line--minor"
              />
            </g>
          );
        })}
        {majorTicks.map((tick) => {
          const x = mapTimeToLocalX(tick);
          return (
            <g key={`major-${tick}`}>
              <line
                x1={x}
                y1={TICK_TOP}
                x2={x}
                y2={TICK_BOTTOM}
                className="timeline-scale__line timeline-scale__line--major"
              />
            </g>
          );
        })}
        <line
          x1={TIMELINE_PADDING}
          y1={BASELINE_Y}
          x2={svgWidth - TIMELINE_PADDING}
          y2={BASELINE_Y}
          className="timeline-scale__baseline"
        />
        <line
          x1={playheadX}
          y1={0}
          x2={playheadX}
          y2={TIMELINE_HEADER_HEIGHT}
          className="timeline-scale__playhead"
        />
        {visibleCues.map((cue) => {
          const x = mapTimeToLocalX(cue.t);
          return (
            <g
              key={cue.id}
              className="timeline-cue"
              onClick={(event) => {
                event.stopPropagation();
              }}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => beginCueDrag(event, cue)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setCueMenu({
                  cueId: cue.id,
                  cue,
                  x: event.clientX,
                  y: event.clientY,
                });
              }}
            >
              <line x1={x} y1={CUE_TOP} x2={x} y2={CUE_BOTTOM} />
              <polygon
                className="timeline-cue__marker"
                points={`${x},${CUE_DOT_Y - CUE_MARKER_HALF} ${x + CUE_MARKER_HALF},${CUE_DOT_Y} ${x},${CUE_DOT_Y + CUE_MARKER_HALF} ${x - CUE_MARKER_HALF},${CUE_DOT_Y}`}
              />
              <text
                x={x}
                y={CUE_DOT_Y}
                className="timeline-cue__label"
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {cue.number}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="timeline-scale__labels">
        {majorTicks.map((tick) => {
          const x = mapTimeToLocalX(tick);
          const percent = (x / svgWidth) * 100;
          const label = formatTimecode(tick, fps);
          if (Math.abs(tick) < Math.max(frameDuration * 0.5, 1e-6)) return null;
          return (
            <span
              key={`label-major-${tick}`}
              className="timeline-scale__label"
              style={{ left: `${percent}%` }}
            >
              {label}
            </span>
          );
        })}
      </div>
      <div
        className={`timeline-loop ${loopEnabled ? 'is-enabled' : 'is-disabled'}`}
        style={{ '--loop-padding': `${loopPaddingPercent}%` }}
      >
        <div className="timeline-loop__rail" />
        <div
          className="timeline-loop__range"
          style={{
            left: `${loopLeftPercent}%`,
            width: `${loopWidthPercent}%`,
          }}
          onPointerDown={(event) => beginLoopHandleDrag(event, 'range')}
        />
        <button
          type="button"
          className="timeline-loop__handle timeline-loop__handle--start"
          style={{ left: `${loopLeftPercent}%` }}
          onPointerDown={(event) => beginLoopHandleDrag(event, 'start')}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (onLoopEdit) onLoopEdit();
          }}
          title="Loop Start"
        >
          ◣
        </button>
        <button
          type="button"
          className="timeline-loop__handle timeline-loop__handle--end"
          style={{ left: `${loopLeftPercent + loopWidthPercent}%` }}
          onPointerDown={(event) => beginLoopHandleDrag(event, 'end')}
          onDoubleClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (onLoopEdit) onLoopEdit();
          }}
          title="Loop End"
        >
          ◢
        </button>
      </div>
      {cueMenu && (
        <div className="timeline-cue-menu" style={{ left: cueMenu.x, top: cueMenu.y }}>
          <button
            type="button"
            className="timeline-cue-menu__item"
            onClick={() => {
              if (onCueEdit && cueMenu.cue) onCueEdit(cueMenu.cue);
              setCueMenu(null);
            }}
          >
            Edit Cue
          </button>
          <button
            type="button"
            className="timeline-cue-menu__item"
            onClick={() => {
              if (onCueDelete) onCueDelete(cueMenu.cueId);
              setCueMenu(null);
            }}
          >
            Delete Cue
          </button>
        </div>
      )}
      <input
        className="timeline-scroll"
        type="range"
        min="0"
        max={Math.max(view.length - (view.end - view.start), 0)}
        step="0.01"
        value={view.start}
        onChange={(event) => onScroll(Number(event.target.value))}
      />
    </div>
  );
}
