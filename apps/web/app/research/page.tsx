'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type LegislativeFile, type Meeting, type Publication } from '../../lib/api';

type Scope = 'all' | 'files' | 'meetings' | 'releases';

export default function ResearchPage() {
  const [files, setFiles] = useState<LegislativeFile[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('all');
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([api.files(), api.meetings(), api.publications()])
      .then(([f,m,p]) => { setFiles(f); setMeetings(m); setPublications(p); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const q = query.trim().toLowerCase();
  const fileHits = useMemo(() => files.filter((f) => !q || [f.ref,f.title,f.status,f.inControl,f.sponsors,f.enactmentNumber].some((v) => v?.toLowerCase().includes(q))), [files,q]);
  const meetingHits = useMemo(() => meetings.filter((m) => !q || [m.body,m.location,m.agendaStatus,m.notes].some((v) => v?.toLowerCase().includes(q))), [meetings,q]);
  const releaseHits = useMemo(() => publications.filter((p) => !q || [p.id,p.kind,p.reason,p.contentHash].some((v) => v?.toLowerCase().includes(q))), [publications,q]);

  return <>
    <nav className="trail"><a href="/">Workspace</a><span>›</span><span className="here">Research desk</span></nav>
    <header className="research-hero"><div><div className="eyebrow">Research</div><h1>Legislative Research Desk</h1><p className="workspace-lede">Search across legislative files, meeting records, and official releases from one place.</p></div></header>
    {error ? <div className="error">{error}</div> : null}
    <div className="research-search card">
      <div className="searchbar"><span aria-hidden>⌕</span><input autoFocus aria-label="Search legislative records" placeholder="Search by file number, title, body, sponsor, enactment, meeting, or hash…" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
      <div className="segmented research-scope">
        {(['all','files','meetings','releases'] as Scope[]).map((s) => <button key={s} className={scope===s?'active':''} onClick={() => setScope(s)}>{s[0]!.toUpperCase()+s.slice(1)}</button>)}
      </div>
    </div>
    {(scope==='all'||scope==='files') ? <section className="research-section"><div className="section-heading"><div><div className="eyebrow">Legislation</div><h2>Files</h2></div><span className="ref">{fileHits.length} matches</span></div><div className="card">{fileHits.slice(0,20).map((f)=><a className="research-row" href={'/proposals/'+f.id} key={f.id}><strong>{f.ref}</strong><span><b>{f.title}</b><small>{f.status} · {f.inControl}{f.sponsors ? ' · '+f.sponsors : ''}</small></span><em className={'status-chip status-'+f.status.toLowerCase().replaceAll(' ','-')}>{f.status}</em></a>)}{!fileHits.length?<div className="empty">No legislative files match this query.</div>:null}</div></section>:null}
    {(scope==='all'||scope==='meetings') ? <section className="research-section"><div className="section-heading"><div><div className="eyebrow">Calendar</div><h2>Meetings</h2></div><span className="ref">{meetingHits.length} matches</span></div><div className="card">{meetingHits.slice(0,12).map((m)=><a className="research-row" href={'/meetings/'+m.id} key={m.id}><strong>{new Date(m.meetingAt).toLocaleDateString()}</strong><span><b>{m.body}</b><small>{new Date(m.meetingAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}{m.location?' · '+m.location:''}</small></span><em className="status-chip">{m.agendaStatus}</em></a>)}{!meetingHits.length?<div className="empty">No meetings match this query.</div>:null}</div></section>:null}
    {(scope==='all'||scope==='releases') ? <section className="research-section"><div className="section-heading"><div><div className="eyebrow">Custody</div><h2>Official releases</h2></div><span className="ref">{releaseHits.length} matches</span></div><div className="card">{releaseHits.slice(0,12).map((p)=><a className="research-row" href="/publications" key={p.id}><strong>v{p.version}</strong><span><b>{p.kind.replaceAll('_',' ')}</b><small>{new Date(p.publishedAt).toLocaleString()} · {p.contentHash.slice(0,18)}…</small></span><em className="status-chip">Released</em></a>)}{!releaseHits.length?<div className="empty">No official releases match this query.</div>:null}</div></section>:null}
  </>;
}