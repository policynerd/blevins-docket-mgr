'use client';

import { use, useEffect, useState } from 'react';

import { api, type TemplatePreview } from '../../../lib/api';

export default function TemplateDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [row, setRow] = useState<TemplatePreview>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .template(id)
      .then(setRow)
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!row) return <div className="empty">Loading…</div>;

  return (
    <>
      <nav className="trail">
        <a href="/templates">Templates</a>
        <span aria-hidden>›</span>
        <span className="here">{row.name}</span>
      </nav>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>{row.name}</h1>
          <div className="ref">
            {row.path.join(' / ')} · {row.id}
          </div>
        </div>
        <a className="btn primary" href={`/proposals/new?template=${row.id}`}>
          Start from this template
        </a>
      </div>
      <h2>Packet</h2>
      <ol>
        {row.documents.map((d) => (
          <li key={d.docType}>
            <strong>{d.title}</strong> <span className="meta">{d.docType}</span>
          </li>
        ))}
      </ol>
      {row.boardLetter ? (
        <>
          <h2>Board letter</h2>
          <div className="card" style={{ padding: 'var(--space-5)' }}>
            {row.boardLetter.map((s) => (
              <div key={s.num} className="field">
                <span>
                  {s.num} {s.title}
                </span>
                {s.help}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {row.fiscal ? (
        <>
          <h2>Fiscal impact</h2>
          <div className="card" style={{ padding: 'var(--space-5)' }}>
            {row.fiscal.map((s) => (
              <div key={s.num} className="field">
                <span>
                  {s.num} {s.title}
                </span>
                {s.help}
              </div>
            ))}
          </div>
        </>
      ) : null}
      {row.forms.map((f) => (
        <section key={f.name}>
          <h2>{f.name} form</h2>
          <pre className="form-text">{f.text}</pre>
        </section>
      ))}
    </>
  );
}
