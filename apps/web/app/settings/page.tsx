'use client';

import { useEffect, useState } from 'react';

import { api, type Meta } from '../../lib/api';

const PREFS_KEY = 'blevins-drafting-prefs';

type Prefs = {
  guidance: boolean;
  textSize: 'sm' | 'md' | 'lg';
  confirmLeave: boolean;
};

const defaults: Prefs = { guidance: true, textSize: 'md', confirmLeave: true };

function loadPrefs(): Prefs {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') };
  } catch {
    return defaults;
  }
}

export default function SettingsPage() {
  const [meta, setMeta] = useState<Meta>();
  const [prefs, setPrefs] = useState<Prefs>(defaults);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setPrefs(loadPrefs());
    api
      .meta()
      .then(setMeta)
      .catch((e: Error) => setError(e.message));
  }, []);

  function update(next: Partial<Prefs>) {
    const merged = { ...prefs, ...next };
    setPrefs(merged);
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged));
    document.documentElement.dataset['textSize'] = merged.textSize;
  }

  return (
    <>
      <h1>Settings</h1>
      <div className="ref">Drafting preferences on this browser, and what this deployment has wired up.</div>

      {error ? <div className="error">{error}</div> : null}

      <h2 className="section-label">This browser</h2>
      <div className="card" style={{ padding: 'var(--space-5)' }}>
        <label className="field">
          <span>Show drafting guidance</span>
          <input
            type="checkbox"
            checked={prefs.guidance}
            onChange={(e) => update({ guidance: e.target.checked })}
          />
        </label>
        <label className="field">
          <span>Editor text size</span>
          <select
            value={prefs.textSize}
            onChange={(e) => update({ textSize: e.target.value as Prefs['textSize'] })}
          >
            <option value="sm">Small</option>
            <option value="md">Regular</option>
            <option value="lg">Large</option>
          </select>
        </label>
        <label className="field">
          <span>Warn before leaving an unsaved line</span>
          <input
            type="checkbox"
            checked={prefs.confirmLeave}
            onChange={(e) => update({ confirmLeave: e.target.checked })}
          />
        </label>
      </div>

      <h2 className="section-label">This deployment</h2>
      <div className="card" style={{ padding: 'var(--space-5)' }}>
        <div className="field">
          <span>Sign-in (Entra)</span>
          {meta ? (meta.signInConfigured ? 'Configured' : 'Not configured — set ENTRA_* secrets') : '…'}
        </div>
        <div className="field">
          <span>Public origin</span>
          {meta?.appBaseUrl ?? 'not set'}
        </div>
        <div className="field">
          <span>Chromium path provided</span>
          {meta ? (meta.chromium ? 'Yes (CHROMIUM_PATH)' : 'No — renderer will search common binaries') : '…'}
        </div>
      </div>
    </>
  );
}
