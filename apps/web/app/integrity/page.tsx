'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type Meeting, type Publication } from '../../lib/api';

export default function IntegrityPage() {
  const [publications,setPublications]=useState<Publication[]>([]);
  const [meetings,setMeetings]=useState<Meeting[]>([]);
  const [error,setError]=useState<string>();

  useEffect(()=>{Promise.all([api.publications(),api.meetings()]).then(([p,m])=>{setPublications(p);setMeetings(m)}).catch((e:Error)=>setError(e.message));},[]);

  const badHash=publications.filter((p)=>!p.contentHash || p.contentHash.length<32);
  const releasesByKind=useMemo(()=>[...publications.reduce((map,p)=>map.set(p.kind,(map.get(p.kind)||0)+1),new Map<string,number>()).entries()].sort((a,b)=>b[1]-a[1]),[publications]);
  const finalMeetings=meetings.filter((m)=>m.agendaStatus==='Final');
  const releaseDays=publications.length?Math.max(1,Math.ceil((Date.now()-Math.min(...publications.map((p)=>+new Date(p.publishedAt))))/86400000)):0;

  return <>
    <nav className="trail"><a href="/">Workspace</a><span>›</span><span className="here">Record integrity</span></nav>
    <header className="integrity-hero"><div><div className="eyebrow">Custody & Assurance</div><h1>Record Integrity</h1><p className="workspace-lede">Operational assurance for released agendas and legislative records.</p></div><a className="btn" href="/publications">Open registry</a></header>
    {error?<div className="error">{error}</div>:null}
    <section className="metric-grid integrity-metrics">
      <div className="metric"><span>Official releases</span><strong>{publications.length}</strong><small>registered publications</small></div>
      <div className="metric"><span>Hash exceptions</span><strong>{badHash.length}</strong><small>missing or malformed hashes</small></div>
      <div className="metric"><span>Final agendas</span><strong>{finalMeetings.length}</strong><small>meetings marked final</small></div>
      <div className="metric"><span>Registry span</span><strong>{releaseDays}</strong><small>days represented</small></div>
    </section>
    <div className="integrity-grid">
      <section className="card">
        <div className="integrity-section-head"><div><div className="eyebrow">Verification</div><h2>Latest releases</h2></div><span className={'integrity-state '+(badHash.length?'warn':'ok')}>{badHash.length?'Review required':'No hash exceptions'}</span></div>
        {publications.slice().sort((a,b)=>+new Date(b.publishedAt)-+new Date(a.publishedAt)).slice(0,15).map((p)=><div className="integrity-row" key={p.id}><div><strong>{p.kind.replaceAll('_',' ')} · v{p.version}</strong><span>{new Date(p.publishedAt).toLocaleString()}</span></div><code title={p.contentHash}>{p.contentHash.slice(0,20)}…</code><em className={'integrity-dot '+(p.contentHash.length>=32?'ok':'warn')} aria-label={p.contentHash.length>=32?'Hash present':'Hash exception'} /></div>)}
        {!publications.length?<div className="empty">No official releases have been registered.</div>:null}
      </section>
      <aside className="card">
        <div className="integrity-section-head"><div><div className="eyebrow">Registry mix</div><h2>Release types</h2></div></div>
        {releasesByKind.map(([kind,count])=><div className="integrity-kind" key={kind}><span>{kind.replaceAll('_',' ')}</span><strong>{count}</strong></div>)}
        {!releasesByKind.length?<div className="empty">No release types yet.</div>:null}
      </aside>
    </div>
  </>;
}