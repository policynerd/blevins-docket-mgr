'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type LegislativeFile, type Meeting } from '../../lib/api';

export default function AgendaPrepPage() {
  const [files, setFiles] = useState<LegislativeFile[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([api.files(), api.meetings()])
      .then(([f,m]) => { setFiles(f); setMeetings(m); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const ready = useMemo(() => files.filter((f) => ['Ready for Agenda','Referred','In Committee'].includes(f.status)), [files]);
  const byControl = useMemo(() => {
    const groups = new Map<string, LegislativeFile[]>();
    ready.forEach((f) => groups.set(f.inControl || 'Unassigned', [...(groups.get(f.inControl || 'Unassigned') ?? []), f]));
    return [...groups.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  }, [ready]);
  const upcoming = useMemo(() => meetings.filter((m) => new Date(m.meetingAt) >= new Date()).sort((a,b)=>+new Date(a.meetingAt)-+new Date(b.meetingAt)).slice(0,8), [meetings]);

  return <>
    <nav className="trail"><a href="/">Workspace</a><span>›</span><span className="here">Agenda prep</span></nav>
    <header className="agenda-prep-hero"><div><div className="eyebrow">Agenda Management</div><h1>Agenda Preparation</h1><p className="workspace-lede">Stage eligible files against upcoming meetings and spot agenda-control issues before publication.</p></div><a className="btn primary" href="/meetings">Open meeting calendar</a></header>
    {error ? <div className="error">{error}</div> : null}
    <section className="agenda-prep-metrics metric-grid">
      <div className="metric"><span>Eligible files</span><strong>{ready.length}</strong><small>ready, referred, or in committee</small></div>
      <div className="metric"><span>Upcoming meetings</span><strong>{upcoming.length}</strong><small>next eight shown</small></div>
      <div className="metric"><span>Draft agendas</span><strong>{upcoming.filter((m)=>m.agendaStatus!=='Final').length}</strong><small>not yet final</small></div>
      <div className="metric"><span>Control groups</span><strong>{byControl.length}</strong><small>offices or bodies</small></div>
    </section>
    <div className="agenda-prep-grid">
      <section>
        <div className="section-heading"><div><div className="eyebrow">Queue</div><h2>Eligible legislative files</h2></div></div>
        {byControl.map(([control,group]) => <article className="agenda-group card" key={control}>
          <header><div><strong>{control}</strong><span>{group.length} file{group.length===1?'':'s'}</span></div></header>
          {group.map((f)=><a className="agenda-prep-row" href={'/proposals/'+f.id} key={f.id}><strong>{f.ref}</strong><span><b>{f.title}</b><small>{f.sponsors || 'No sponsor listed'}</small></span><em className={'status-chip status-'+f.status.toLowerCase().replaceAll(' ','-')}>{f.status}</em></a>)}
        </article>)}
        {!ready.length?<div className="card empty">No files currently meet the agenda-prep criteria.</div>:null}
      </section>
      <aside>
        <div className="section-heading"><div><div className="eyebrow">Calendar</div><h2>Upcoming meetings</h2></div></div>
        <div className="card agenda-calendar">{upcoming.map((m)=><a href={'/meetings/'+m.id} className="agenda-calendar-row" key={m.id}><div className="agenda-calendar-date"><strong>{new Date(m.meetingAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</strong><span>{new Date(m.meetingAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}</span></div><div><strong>{m.body}</strong><span>{m.location || 'Location not specified'}</span><em className="status-chip">{m.agendaStatus}</em></div></a>)}</div>
      </aside>
    </div>
  </>;
}