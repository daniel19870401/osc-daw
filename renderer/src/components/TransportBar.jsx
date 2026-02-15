import React, { useEffect, useRef, useState } from 'react';

export default function TransportBar({
  projectName,
  sync,
  syncFps,
  syncFpsOptions = [],
  currentTime,
  isPlaying,
  isRecording,
  isLoopEnabled,
  onPlayToggle,
  onRecordToggle,
  onLoopToggle,
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
  onTimecodeCommit,
}) {
  const [isSyncMenuOpen, setIsSyncMenuOpen] = useState(false);
  const [isSyncFpsMenuOpen, setIsSyncFpsMenuOpen] = useState(false);
  const [timecodeInput, setTimecodeInput] = useState(currentTime || '00:00:00.00');
  const [isEditingTimecode, setIsEditingTimecode] = useState(false);
  const syncMenuRef = useRef(null);
  const syncFpsMenuRef = useRef(null);
  const selectedSyncFpsLabel =
    syncFpsOptions.find((option) => option.id === syncFps)?.label || syncFps;
  const safeProjectName = typeof projectName === 'string' ? projectName : '';
  const displayProjectName = safeProjectName.slice(0, 20);

  useEffect(() => {
    if (isEditingTimecode) return;
    setTimecodeInput(currentTime || '00:00:00.00');
  }, [currentTime, isEditingTimecode]);

  const commitTimecode = () => {
    if (typeof onTimecodeCommit !== 'function') {
      setTimecodeInput(currentTime || '00:00:00.00');
      return;
    }
    const next = String(timecodeInput || '').trim();
    const ok = onTimecodeCommit(next);
    if (!ok) {
      setTimecodeInput(currentTime || '00:00:00.00');
    }
  };

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
        <div className="project-name" title={safeProjectName}>{displayProjectName}</div>
      </div>
      <div className="transport__center">
        <button
          className={`btn btn--ghost btn--record btn--symbol ${isRecording ? 'is-active' : ''}`}
          onClick={onRecordToggle}
          title="Record"
        >
          ●
        </button>
        <button
          className={`btn btn--ghost btn--symbol ${isPlaying ? 'is-active' : ''}`}
          onClick={onPlayToggle}
          title={isPlaying ? 'Pause' : 'Play'}
        >
          ►
        </button>
        <button
          className="btn btn--ghost btn--symbol"
          onClick={onStop}
          onDoubleClick={onStopLocate}
          title="Double-click to return to start"
        >
          ■
        </button>
        <button
          className={`btn btn--ghost btn--symbol ${isLoopEnabled ? 'is-active' : ''}`}
          onClick={onLoopToggle}
          title="Loop"
        >
          ↺
        </button>
        <input
          className="transport__time"
          value={timecodeInput}
          onFocus={() => setIsEditingTimecode(true)}
          onChange={(event) => setTimecodeInput(event.target.value)}
          onBlur={() => {
            setIsEditingTimecode(false);
            commitTimecode();
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitTimecode();
              event.currentTarget.blur();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              setTimecodeInput(currentTime || '00:00:00.00');
              event.currentTarget.blur();
            }
          }}
          spellCheck={false}
          title="Timecode (hh:mm:ss.ff)"
        />
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
        <button className="btn btn--ghost" onClick={onOpenSettings}>Settings</button>
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
      </div>
    </header>
  );
}
