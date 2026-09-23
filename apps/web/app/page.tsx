'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type LegislativeFile } from '../lib/api';

function asFile(p: { id: string; ref: string; title: string; templateId?: string; updatedAt: string }): LegislativeFile {
  return { id: p.id, ref: p.ref, title: p.title, templateId: p.templateId, status: 'Draft',
    inControl: 'Office of the General Counsel', agendaDate: null, enactmentNumber: null, finalActionAt: null, updatedAt: p.updatedAt };
}

export default function FilesPage() {
  const [rows, setRows] = useState<LegislativeFile[]>();
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  useEffect(() => {
    api.files().catch(() => api.proposals().then((list) => list.map(asFile))).then(setRows).catch((e: Error) => setError(e.message));
  }, []);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows?.filter((p) => [p.ref,p.title,p.status,p.inControl,p.sponsors].some((v) => v?.toLowerCase().includes(q)));
  }, [query, rows]);

  return <>
    <div className="toolbar">
      <div style={{flex:1}}><div className="eyebrow">Legislation</div><h1>Legislative Files</h1>
        <div className="ref">Official matters from drafting through final action and enactment</div></div>
      <a className="btn" href="/docket">Today&apos;s Docket</a>
      <a className="btn primary" href="/proposals/new">New file</a>
    </div>
    <div className="searchbar"><span aria-hidden>⌕</span><input aria-label="Search legislative files" placeholder="Search file number, title, status, body, or sponsor" value={query} onChange={(e)=>setQuery(e.target.value)} /></div>
    {error ? <div className="error">{error}</div> : null}
    <div className="record-table card">
      <div className="record-head"><span>File</span><span>Title</span><span>Status</span><span>In Control</span><span>Updated</span></div>
      {filtered === undefined && !error ? <div className="empty">Loading…</div> : null}
      {filtered?.length === 0 ? <div className="empty">No legislative files match this view.</div> : null}
      {filtered?.map((p)=><a key={p.id} className="record-line" href={`/proposals/${p.id}`}>
        <strong className="file-ref">{p.ref}</strong><span><b>{p.title}</b>{p.enactmentNumber ? <small>{p.enactmentNumber}</small>:null}</span>
        <span><em className={`status-chip status-${p.status.toLowerCase().replaceAll(' ','-')}`}>{p.status}</em></span>
        <span>{p.inControl}</span><span>{new Date(p.updatedAt).toLocaleDateString()}</span>
      </a>)}
    </div>
  </>;
}
