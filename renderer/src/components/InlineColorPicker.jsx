import React, { useEffect, useMemo, useRef, useState } from 'react';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const HEX_COLOR_RE = /^#([0-9a-f]{6})$/i;

const toHex = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');

const rgbToHex = ({ r, g, b }) => `#${toHex(r)}${toHex(g)}${toHex(b)}`;

const hexToRgb = (value) => {
  const match = HEX_COLOR_RE.exec(typeof value === 'string' ? value : '');
  const hex = match ? match[1] : '000000';
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16),
  };
};

const rgbToHsv = ({ r, g, b }) => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : delta / max;
  const v = max;
  return { h, s, v };
};

const hsvToRgb = ({ h, s, v }) => {
  const hue = ((h % 360) + 360) % 360;
  const c = v * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = v - c;
  let rn = 0;
  let gn = 0;
  let bn = 0;
  if (hue < 60) {
    rn = c;
    gn = x;
  } else if (hue < 120) {
    rn = x;
    gn = c;
  } else if (hue < 180) {
    gn = c;
    bn = x;
  } else if (hue < 240) {
    gn = x;
    bn = c;
  } else if (hue < 300) {
    rn = x;
    bn = c;
  } else {
    rn = c;
    bn = x;
  }
  return {
    r: (rn + m) * 255,
    g: (gn + m) * 255,
    b: (bn + m) * 255,
  };
};

const getPointerRatio = (event, element) => {
  const rect = element.getBoundingClientRect();
  const x = clamp((event.clientX - rect.left) / Math.max(rect.width, 1), 0, 1);
  const y = clamp((event.clientY - rect.top) / Math.max(rect.height, 1), 0, 1);
  return { x, y };
};

export default function InlineColorPicker({ value = '#000000', onChange }) {
  const [hsv, setHsv] = useState(() => rgbToHsv(hexToRgb(value)));
  const squareRef = useRef(null);
  const hueRef = useRef(null);
  const dragStateRef = useRef({ mode: null });

  useEffect(() => {
    setHsv((prev) => {
      const next = rgbToHsv(hexToRgb(value));
      const near =
        Math.abs(prev.h - next.h) < 0.4
        && Math.abs(prev.s - next.s) < 0.002
        && Math.abs(prev.v - next.v) < 0.002;
      return near ? prev : next;
    });
  }, [value]);

  const hueColor = useMemo(() => {
    const rgb = hsvToRgb({ h: hsv.h, s: 1, v: 1 });
    return rgbToHex(rgb);
  }, [hsv.h]);

  const hexColor = useMemo(() => rgbToHex(hsvToRgb(hsv)), [hsv]);

  const emitColor = (next) => {
    const safe = {
      h: clamp(Number(next.h) || 0, 0, 360),
      s: clamp(Number(next.s) || 0, 0, 1),
      v: clamp(Number(next.v) || 0, 0, 1),
    };
    setHsv(safe);
    if (onChange) onChange(rgbToHex(hsvToRgb(safe)));
  };

  const updateSquare = (event) => {
    if (!squareRef.current) return;
    const ratio = getPointerRatio(event, squareRef.current);
    emitColor({ ...hsv, s: ratio.x, v: 1 - ratio.y });
  };

  const updateHue = (event) => {
    if (!hueRef.current) return;
    const ratio = getPointerRatio(event, hueRef.current);
    emitColor({ ...hsv, h: ratio.x * 360 });
  };

  const onPointerMove = (event) => {
    if (dragStateRef.current.mode === 'square') {
      updateSquare(event);
    } else if (dragStateRef.current.mode === 'hue') {
      updateHue(event);
    }
  };

  const stopDrag = () => {
    dragStateRef.current.mode = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDrag);
    window.removeEventListener('pointercancel', stopDrag);
  };

  const startDrag = (mode, event) => {
    dragStateRef.current.mode = mode;
    if (mode === 'square') updateSquare(event);
    else updateHue(event);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
  };

  useEffect(() => () => stopDrag(), []);

  return (
    <div className="inline-color-picker">
      <div
        ref={squareRef}
        className="inline-color-picker__square"
        style={{ '--picker-hue': hueColor }}
        onPointerDown={(event) => startDrag('square', event)}
      >
        <div className="inline-color-picker__white" />
        <div className="inline-color-picker__black" />
        <div
          className="inline-color-picker__target"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
          }}
        />
      </div>
      <div
        ref={hueRef}
        className="inline-color-picker__hue"
        onPointerDown={(event) => startDrag('hue', event)}
      >
        <div
          className="inline-color-picker__hue-target"
          style={{ left: `${(hsv.h / 360) * 100}%` }}
        />
      </div>
      <div className="inline-color-picker__preview-row">
        <div className="inline-color-picker__preview" style={{ background: hexColor }} />
        <div className="inline-color-picker__hex">{hexColor.toUpperCase()}</div>
      </div>
    </div>
  );
}
