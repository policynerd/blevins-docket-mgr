'use client';

import { useEffect, useState } from 'react';

import { api, type Template } from '../../lib/api';

export default function TemplatesPage() {
  const [rows, setRows] = useState<Template[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .templates()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>Templates</h1>
          <div className="ref">The twelve instruments this office issues. Open one to read the form, then start a proposal.</div>
        </div>
        <a className="btn primary" href="/proposals/new">
          New proposal
        </a>
      </div>

      {error ? <div className="error">{error}</div> : null}
      {rows === undefined && !error ? <div className="empty">Loading…</div> : null}

      <div className="card">
        {rows?.map((t) => (
          <a key={t.id} className="row" href={`/templates/${t.id}`}>
            <div className="title">{t.name}</div>
            <div className="meta">{t.path.join(' / ')} · {t.id}</div>
            <div className="hint">{t.documents.map((d) => d.title).join(' · ')}</div>
          </a>
        ))}
      </div>
    </>
  );
}
