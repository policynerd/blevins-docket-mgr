'use client';

import { useEffect, useState } from 'react';

import { api, type Meta } from '../../lib/api';
import {
  defaultFooterLinks,
  loadFooterLinks,
  saveFooterLinks,
  type FooterGroup,
  type FooterLink,
} from '../../lib/footer';

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
  const [links, setLinks] = useState<FooterLink[]>(defaultFooterLinks);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPrefs(loadPrefs());
    setLinks(loadFooterLinks());
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

  function patchLink(id: string, next: Partial<FooterLink>) {
    setLinks((rows) => rows.map((row) => (row.id === id ? { ...row, ...next } : row)));
    setSaved(false);
  }

  function addLink(group: FooterGroup) {
    setLinks((rows) => [
      ...rows,
      { id: crypto.randomUUID(), label: '', href: 'https://', group },
    ]);
    setSaved(false);
  }

  function removeLink(id: string) {
    setLinks((rows) => rows.filter((row) => row.id !== id));
    setSaved(false);
  }

  function persistFooter() {
    saveFooterLinks(links);
    setSaved(true);
  }

  function resetFooter() {
    setLinks(defaultFooterLinks);
    saveFooterLinks(defaultFooterLinks);
    setSaved(true);
  }

  const groups: { id: FooterGroup; title: string; hint: string }[] = [
    {
      id: 'organization',
      title: 'Organization',
      hint: 'Corporate homepage, this drafting app, the docket manager, committee sites.',
    },
    { id: 'legal', title: 'Legal', hint: 'Terms, privacy, accessibility, records policy.' },
    { id: 'social', title: 'Social', hint: 'Leave the URL blank to hide a network from the footer.' },
  ];

  return (
    <>
      <h1>Settings</h1>
      <div className="ref">Drafting preferences, deployment wiring, and the public footer.</div>

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

      <h2 className="section-label" id="footer">
        Footer links
      </h2>
      <p className="ref" style={{ marginBottom: '0.75rem' }}>
        These links render on every page. Blank URLs are hidden. Saved in this browser until we
        promote them to a tenant setting.
      </p>
      {groups.map((g) => (
        <div key={g.id} className="card" style={{ padding: 'var(--space-5)', marginBottom: '1rem' }}>
          <h3 style={{ marginTop: 0 }}>{g.title}</h3>
          <p className="ref">{g.hint}</p>
          {links
            .filter((l) => l.group === g.id)
            .map((l) => (
              <div key={l.id} className="inline-form" style={{ marginTop: '0.5rem' }}>
                <input
                  type="text"
                  value={l.label}
                  placeholder="Label"
                  onChange={(e) => patchLink(l.id, { label: e.target.value })}
                  aria-label="Link label"
                />
                <input
                  type="text"
                  value={l.href}
                  placeholder="https://…"
                  onChange={(e) => patchLink(l.id, { href: e.target.value })}
                  aria-label="Link address"
                />
                <button type="button" onClick={() => removeLink(l.id)}>
                  Remove
                </button>
              </div>
            ))}
          <button type="button" style={{ marginTop: '0.75rem' }} onClick={() => addLink(g.id)}>
            Add {g.title.toLowerCase()} link
          </button>
        </div>
      ))}
      <div className="toolbar">
        <button className="primary" type="button" onClick={persistFooter}>
          Save footer
        </button>
        <button type="button" onClick={resetFooter}>
          Restore defaults
        </button>
        {saved ? <span className="status saved">Footer saved</span> : null}
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
