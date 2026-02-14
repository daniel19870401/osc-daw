import React, { useEffect, useRef, useState } from 'react';

export default function TransportBar({
  projectName,
  sync,
  syncFps,
  syncFpsOptions = [],
  currentTime,
  isPlaying,
  isRecording,
  onPlayToggle,
  onRecordToggle,
  onStop,
  onStopLocate,
  onOpenSettings,
  onSave,
  onLoad,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onSyncChange,
  onSyncFpsChange,
  isCompositionsVisible,
  isInspectorVisible,
  onToggleCompositions,
  onToggleInspector,
}) {
  const [isSyncMenuOpen, setIsSyncMenuOpen] = useState(false);
  const [isSyncFpsMenuOpen, setIsSyncFpsMenuOpen] = useState(false);
  const syncMenuRef = useRef(null);
  const syncFpsMenuRef = useRef(null);
  const selectedSyncFpsLabel =
    syncFpsOptions.find((option) => option.id === syncFps)?.label || syncFps;

  useEffect(() => {
    if (!isSyncMenuOpen) return undefined;
    const handleOutside = (event) => {
      if (syncMenuRef.current?.contains(event.target)) return;
      setIsSyncMenuOpen(false);
    };
    window.addEventListener('pointerdown', handleOutside, true);
    return () => window.removeEventListener('pointerdown', handleOutside, true);
  }, [isSyncMenuOpen]);

  useEffect(() => {
    if (!isSyncFpsMenuOpen) return undefined;
    const handleOutside = (event) => {
      if (syncFpsMenuRef.current?.contains(event.target)) return;
      setIsSyncFpsMenuOpen(false);
    };
    window.addEventListener('pointerdown', handleOutside, true);
    return () => window.removeEventListener('pointerdown', handleOutside, true);
  }, [isSyncFpsMenuOpen]);

  return (
    <header className="transport">
      <div className="transport__left">
        <div className="badge">OSC DAW</div>
        <div className="project-name">{projectName}</div>
      </div>
      <div className="transport__center">
        <button
          className={`btn btn--ghost btn--record ${isRecording ? 'is-active' : ''}`}
          onClick={onRecordToggle}
        >
          Rec
        </button>
        <button className="btn btn--ghost" onClick={onPlayToggle}>
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button
          className="btn btn--ghost"
          onClick={onStop}
          onDoubleClick={onStopLocate}
          title="Double-click to return to start"
        >
          Stop
        </button>
        <div className="transport__time">{currentTime}</div>
      </div>
      <div className="transport__right">
        <div className="transport-sync" ref={syncMenuRef}>
          <button
            type="button"
            className="chip chip--button"
            onClick={() => {
              setIsSyncFpsMenuOpen(false);
              setIsSyncMenuOpen((prev) => !prev);
            }}
          >
            Sync: {sync}
          </button>
          {isSyncMenuOpen && (
            <div className="transport-sync__menu">
              <button
                type="button"
                className={`transport-sync__item ${sync === 'Internal' ? 'is-active' : ''}`}
                onClick={() => {
                  if (onSyncChange) onSyncChange('Internal');
                  setIsSyncMenuOpen(false);
                }}
              >
                Internal
              </button>
              <button
                type="button"
                className={`transport-sync__item ${sync === 'MTC' ? 'is-active' : ''}`}
                onClick={() => {
                  if (onSyncChange) onSyncChange('MTC');
                  setIsSyncMenuOpen(false);
                }}
              >
                MTC Sync
              </button>
              <button
                type="button"
                className={`transport-sync__item ${sync === 'LTC' ? 'is-active' : ''}`}
                onClick={() => {
                  if (onSyncChange) onSyncChange('LTC');
                  setIsSyncMenuOpen(false);
                }}
              >
                LTC Sync
              </button>
            </div>
          )}
        </div>
        <div className="transport-sync" ref={syncFpsMenuRef}>
          <button
            type="button"
            className="chip chip--button"
            onClick={() => {
              setIsSyncMenuOpen(false);
              setIsSyncFpsMenuOpen((prev) => !prev);
            }}
          >
            Sync FPS: {selectedSyncFpsLabel}
          </button>
          {isSyncFpsMenuOpen && (
            <div className="transport-sync__menu">
              {syncFpsOptions.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={`transport-sync__item ${syncFps === option.id ? 'is-active' : ''}`}
                  onClick={() => {
                    if (onSyncFpsChange) onSyncFpsChange(option.id);
                    setIsSyncFpsMenuOpen(false);
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn--ghost" onClick={onUndo} disabled={!canUndo}>Undo</button>
        <button className="btn btn--ghost" onClick={onRedo} disabled={!canRedo}>Redo</button>
        <button className="btn btn--ghost" onClick={onSave}>Save</button>
        <button className="btn btn--ghost" onClick={onLoad}>Load</button>
        <button
          className={`btn btn--ghost ${isCompositionsVisible ? 'is-active' : ''}`}
          onClick={onToggleCompositions}
          title="Show/Hide compositions panel"
        >
          Comps
        </button>
        <button
          className={`btn btn--ghost ${isInspectorVisible ? 'is-active' : ''}`}
          onClick={onToggleInspector}
          title="Show/Hide inspector panel"
        >
          Inspector
        </button>
        <button className="btn btn--ghost" onClick={onOpenSettings}>Settings</button>
      </div>
    </header>
  );
}
