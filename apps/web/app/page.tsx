'use client';

import { useEffect, useState } from 'react';

import { api } from '../lib/api';

export default function ProposalsPage() {
  const [rows, setRows] =
    useState<{ id: string; ref: string; title: string; updatedAt: string }[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .proposals()
      .then((r) => setRows(r))
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>Proposals</h1>
          <div className="ref">Legislative instruments before the Board</div>
        </div>
        <a className="btn primary" href="/proposals/new">
          New proposal
        </a>
      </div>

      {error ? <div className="error">{error}</div> : null}

      <div className="card">
        {rows === undefined && !error ? <div className="empty">Loading…</div> : null}
        {rows?.length === 0 ? (
          <div className="empty">No proposals yet. Create one to begin drafting.</div>
        ) : null}
        {rows?.map((p) => (
          <a key={p.id} className="row" href={`/proposals/${p.id}`}>
            <div className="title">{p.title}</div>
            <div className="meta">
              {p.ref} · updated {new Date(p.updatedAt).toLocaleString()}
            </div>
          </a>
        ))}
      </div>
    </>
  );
}
