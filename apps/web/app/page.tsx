'use client';

import { useEffect, useState } from 'react';

import { api, type LegislativeFile } from '../lib/api';

function asFile(p: {
  id: string;
  ref: string;
  title: string;
  templateId?: string;
  updatedAt: string;
}): LegislativeFile {
  return {
    id: p.id,
    ref: p.ref,
    title: p.title,
    templateId: p.templateId,
    status: 'Draft',
    inControl: 'Office of the General Counsel',
    agendaDate: null,
    enactmentNumber: null,
    finalActionAt: null,
    updatedAt: p.updatedAt,
  };
}

export default function FilesPage() {
  const [rows, setRows] = useState<LegislativeFile[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .files()
      .catch(() => api.proposals().then((list) => list.map(asFile)))
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>Files</h1>
          <div className="ref">Legislative files — draft, approve, schedule, act, enact</div>
        </div>
        <a className="btn" href="/meetings">
          Calendar
        </a>
        <a className="btn primary" href="/proposals/new">
          New file
        </a>
      </div>
      {error ? <div className="error">{error}</div> : null}
      <div className="card">
        {rows === undefined && !error ? <div className="empty">Loading…</div> : null}
        {rows?.length === 0 ? (
          <div className="empty">
            No files yet. <a href="/proposals/new">Create one</a> from a template.
          </div>
        ) : null}
        {rows?.map((p) => (
          <a key={p.id} className="row" href={`/proposals/${p.id}`}>
            <div className="title">{p.title}</div>
            <div className="meta">
              {p.ref} · {p.status} · In control: {p.inControl}
              {p.agendaDate ? ` · Agenda ${p.agendaDate}` : ''}
              {p.enactmentNumber ? ` · ${p.enactmentNumber}` : ''}
            </div>
            <div className="hint">Open file</div>
          </a>
        ))}
      </div>
    </>
  );
}
