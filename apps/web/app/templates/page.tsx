'use client';

import { useEffect, useState } from 'react';

import { api, type TemplatePreview } from '../../lib/api';

export default function TemplatesPage() {
  const [rows, setRows] = useState<TemplatePreview[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .templatePreviews()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>Templates</h1>
          <div className="ref">The twelve instruments this office issues. Read the form before you open the editor.</div>
        </div>
        <a className="btn primary" href="/proposals/new">
          New proposal
        </a>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {rows === undefined && !error ? <div className="empty">Loading…</div> : null}

      <div className="template-grid">
        {rows?.map((t) => (
          <a key={t.id} className="template-card" href={`/templates/${t.id}`}>
            <div className="meta">{t.path.join(' / ')}</div>
            <div className="title">{t.name}</div>
            <div className="hint">{t.documents.map((d) => d.title).join(' · ')}</div>
            <code>{t.id}</code>
          </a>
        ))}
      </div>
    </>
  );
}
