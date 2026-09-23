'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type LegislativeFile, type Meeting } from '../../lib/api';

export default function DocketPage() {
  const [files,setFiles]=useState<LegislativeFile[]>([]);
  const [meetings,setMeetings]=useState<Meeting[]>([]);
  const [error,setError]=useState<string>();
  useEffect(()=>{ Promise.all([api.files(),api.meetings()]).then(([f,m])=>{setFiles(f);setMeetings(m)}).catch((e:Error)=>setError(e.message)); },[]);
  const today=new Date();
  const todayMeetings=useMemo(()=>meetings.filter(m=>new Date(m.meetingAt).toDateString()===today.toDateString()),[meetings]);
  const pending=files.filter(f=>!['Adopted','Failed','Withdrawn','Filed','Abandoned'].includes(f.status));
  const recent=[...files].sort((a,b)=>+new Date(b.updatedAt)-+new Date(a.updatedAt)).slice(0,8);
  return <>
    <div className="toolbar"><div style={{flex:1}}><div className="eyebrow">Clerk Workspace</div><h1>Today&apos;s Docket</h1>
      <div className="ref">{today.toLocaleDateString(undefined,{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</div></div>
      <a className="btn" href="/meetings">Calendar</a><a className="btn primary" href="/proposals/new">New file</a>
    </div>
    {error?<div className="error">{error}</div>:null}
    <div className="metric-grid">
      <div className="metric"><span>Meetings today</span><strong>{todayMeetings.length}</strong></div>
      <div className="metric"><span>Active files</span><strong>{pending.length}</strong></div>
      <div className="metric"><span>Ready for agenda</span><strong>{files.filter(f=>f.status==='Ready for Agenda').length}</strong></div>
      <div className="metric"><span>In committee</span><strong>{files.filter(f=>f.status==='In Committee'||f.status==='Referred').length}</strong></div>
    </div>
    <div className="dashboard-grid">
      <section><h2>Meetings Today</h2><div className="card">{todayMeetings.length?todayMeetings.map(m=><a className="row" key={m.id} href={`/meetings/${m.id}`}><div className="title">{new Date(m.meetingAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})} — {m.body}</div><div className="meta">Agenda {m.agendaStatus}{m.location?` · ${m.location}`:''}</div></a>):<div className="empty">No meetings scheduled today.</div>}</div></section>
      <section><h2>Clerk Queue</h2><div className="card">
        {pending.slice(0,6).map(f=><a className="row" key={f.id} href={`/proposals/${f.id}`}><div className="title">{f.ref} — {f.title}</div><div className="meta">{f.status} · In control: {f.inControl}</div></a>)}
        {!pending.length?<div className="empty">No pending matters.</div>:null}</div></section>
    </div>
    <section style={{marginTop:'var(--space-6)'}}><h2>Recent Legislative Activity</h2><div className="card">
      {recent.map(f=><a className="row" key={f.id} href={`/proposals/${f.id}`}><div className="title">{f.ref} — {f.title}</div><div className="meta">{f.status} · Updated {new Date(f.updatedAt).toLocaleString()}</div></a>)}
    </div></section>
  </>;
}
