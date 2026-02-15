import React, { useMemo } from 'react';
import {
  TIMELINE_PADDING,
  TIMELINE_WIDTH,
  clamp,
} from '../utils/timelineMetrics.js';

const MAX_PREVIEW_TRACKS = 10;

export default function GroupLane({
  track,
  members = [],
  view,
  height,
  width,
}) {
  const expanded = track?.group?.expanded !== false;
  const contentWidth = Math.max(Number(width) || TIMELINE_WIDTH, TIMELINE_PADDING * 2 + 1);
  const previewMembers = useMemo(
    () => (Array.isArray(members) ? members.slice(0, MAX_PREVIEW_TRACKS) : []),
    [members]
  );

  const mapTimeToLocalX = (time) => {
    const span = Math.max(Number(view?.end) - Number(view?.start), 0.0001);
    return ((time - Number(view?.start || 0)) / span) * (contentWidth - 2 * TIMELINE_PADDING) + TIMELINE_PADDING;
  };

  if (expanded) {
    return (
      <div className="group-lane group-lane--expanded">
        <svg
          className="group-lane__svg"
          viewBox={`0 0 ${contentWidth} ${height}`}
          preserveAspectRatio="none"
        >
          <rect x="0" y="0" width={contentWidth} height={height} className="group-lane__bg" />
        </svg>
      </div>
    );
  }

  if (!previewMembers.length) {
    return (
      <div className="group-lane group-lane--collapsed">
        <svg
          className="group-lane__svg"
          viewBox={`0 0 ${contentWidth} ${height}`}
          preserveAspectRatio="none"
        >
          <rect x="0" y="0" width={contentWidth} height={height} className="group-lane__bg" />
        </svg>
      </div>
    );
  }

  const rowHeight = Math.max((height - TIMELINE_PADDING * 2) / previewMembers.length, 6);

  return (
    <div className="group-lane group-lane--collapsed">
      <svg
        className="group-lane__svg"
        viewBox={`0 0 ${contentWidth} ${height}`}
        preserveAspectRatio="none"
      >
        <rect x="0" y="0" width={contentWidth} height={height} className="group-lane__bg" />
        {previewMembers.map((member, index) => {
          const y = TIMELINE_PADDING + index * rowHeight;
          const yMid = y + rowHeight * 0.5;
          const accent = typeof member?.color === 'string' ? member.color : '#5dd8c7';
          const nodes = Array.isArray(member?.nodes) ? member.nodes : [];
          const visibleNodes = nodes.filter((node) => {
            const t = Number(node?.t);
            return Number.isFinite(t) && t >= Number(view?.start || 0) && t <= Number(view?.end || 0);
          });
          const duration = Math.max(Number(member?.audio?.duration) || 0, 0);
          const clipStart = Math.max(Number(member?.audio?.clipStart) || 0, 0);
          const clipEnd = clipStart + duration;
          const clipVisibleStart = Math.max(clipStart, Number(view?.start || 0));
          const clipVisibleEnd = Math.min(clipEnd, Number(view?.end || 0));
          const clipWidth = Math.max(mapTimeToLocalX(clipVisibleEnd) - mapTimeToLocalX(clipVisibleStart), 0);

          return (
            <g key={`${member?.id || 'member'}-${index}`}>
              <line
                x1={TIMELINE_PADDING}
                y1={yMid}
                x2={contentWidth - TIMELINE_PADDING}
                y2={yMid}
                className="group-lane__row-line"
              />
              <rect
                x={TIMELINE_PADDING}
                y={y + 1}
                width="4"
                height={Math.max(rowHeight - 2, 2)}
                rx="1"
                fill={accent}
                opacity="0.85"
              />
              {member?.kind === 'audio' && clipWidth > 0 && (
                <rect
                  x={mapTimeToLocalX(clipVisibleStart)}
                  y={y + 1}
                  width={clipWidth}
                  height={Math.max(rowHeight - 2, 2)}
                  rx="2"
                  className="group-lane__audio-clip"
                />
              )}
              {visibleNodes.slice(0, 80).map((node, nodeIndex) => {
                const x = mapTimeToLocalX(Number(node.t) || 0);
                return (
                  <line
                    key={`${member?.id || 'member'}-node-${node?.id || nodeIndex}`}
                    x1={x}
                    y1={y + 1}
                    x2={x}
                    y2={y + Math.max(rowHeight - 1, 2)}
                    stroke={accent}
                    strokeWidth={clamp(rowHeight * 0.12, 0.8, 1.4)}
                    opacity="0.95"
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="group-lane__label">{`${members.length} tracks`}</div>
    </div>
  );
}
