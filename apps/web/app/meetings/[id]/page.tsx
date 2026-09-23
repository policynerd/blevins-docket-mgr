'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, type MeetingDetail } from '../../../lib/api';

type Tab='agenda'|'actions'|'record'|'publications';

export default function MeetingPage({params}:{params:Promise<{id:string}>}) {
 const {id}=use(params); const [row,setRow]=useState<MeetingDetail>(); const [error,setError]=useState<string>(); const [busy,setBusy]=useState(false); const [tab,setTab]=useState<Tab>('agenda');
 const load=useCallback(()=>api.meeting(id).then(setRow).catch((e:Error)=>setError(e.message)),[id]); useEffect(()=>{load()},[load]);
 async function act(fn:()=>Promise<unknown>){setBusy(true);setError(undefined);try{await fn();await load()}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 async function amend(){const reason=window.prompt('Reason for amended agenda');if(reason)await act(()=>api.amendAgenda(id,reason))}
 if(error&&!row)return <div className="error">{error}</div>; if(!row)return <div className="empty">Loading…</div>;
 const published=row.agendaStatus==='Final';
 return <>
  <nav className="trail"><a href="/meetings">Meetings</a><span>›</span><span className="here">{row.body}</span></nav>
  <header className="record-hero"><div><div className="eyebrow">Meeting Record</div><h1>{row.body}</h1>
    <div className="ref">{new Date(row.meetingAt).toLocaleString()} · {row.status?.replaceAll('_',' ')??'Scheduled'} · Agenda v{row.agendaVersion??1}</div></div>
    <div className="record-actions"><button onClick={()=>act(()=>api.generateAgenda(id))} disabled={busy}>Generate / refresh</button>
      {!published?<button className="primary" onClick={()=>act(()=>api.publishAgenda(id,'Final'))} disabled={busy}>Publish agenda</button>:<button className="primary" onClick={amend} disabled={busy}>Create amended agenda</button>}</div></header>
  {error?<div className="error" style={{marginTop:'var(--space-4)'}}>{error}</div>:null}
  <div className="record-facts"><div><span>Body</span><strong>{row.body}</strong></div><div><span>Location</span><strong>{row.location||'—'}</strong></div>
    <div><span>Agenda</span><strong>Version {row.agendaVersion??1} · {row.agendaStatus}</strong></div><div><span>Items</span><strong>{row.items.length}</strong></div><div><span>Publications</span><strong>{row.publications?.length??0}</strong></div></div>
  <nav className="tabs record-tabs">{(['agenda','actions','record','publications'] as Tab[]).map(t=><button key={t} className={tab===t?'active':''} onClick={()=>setTab(t)}>{t[0]!.toUpperCase()+t.slice(1)}</button>)}</nav>
  {tab==='agenda'?<div className="card">{row.items.length?row.items.map((item,i)=><div className="row" key={item.id}>{item.proposalId?<a href={`/proposals/${item.proposalId}`}><div className="title">{i+1}. {item.ref} — {item.title}</div><div className="meta">{item.status}</div></a>:<div className="title">{i+1}. {item.heading}</div>}</div>):<div className="empty">No agenda items. Generate the agenda from files in control of this body.</div>}</div>:null}
  {tab==='actions'?<div className="card"><div className="meeting-controls"><button onClick={()=>act(()=>api.meetingEvent(id,'MEETING_CALLED_TO_ORDER'))}>Call to order</button><button onClick={()=>act(()=>api.meetingEvent(id,'ROLL_CALL'))}>Record roll call event</button><button onClick={()=>act(()=>api.meetingEvent(id,'MEETING_ADJOURNED'))}>Adjourn</button><button onClick={()=>act(()=>api.meetingEvent(id,'MINUTES_ADOPTED'))}>Mark minutes adopted</button></div>
    <div className="empty">Matter dispositions are recorded from each legislative file and become part of this meeting&apos;s immutable event ledger.</div></div>:null}
  {tab==='record'?<div className="card timeline">{row.events?.length?row.events.map(e=><div className="timeline-row" key={e.id}><time>{new Date(e.occurredAt).toLocaleString()}</time><div><strong>{e.eventType.replaceAll('_',' ')}</strong><p>{Object.keys(e.detail).length?JSON.stringify(e.detail):'Official meeting event'}</p></div></div>):<div className="empty">No meeting events recorded.</div>}</div>:null}
  {tab==='publications'?<div className="card">{row.publications?.length?row.publications.map(p=><div className="row" key={p.id}><div className="title">{p.kind.replaceAll('_',' ')} · Version {p.version}</div><div className="meta">Published {new Date(p.publishedAt).toLocaleString()} · SHA-256 {p.contentHash.slice(0,16)}…</div>{p.reason?<div className="hint">{p.reason}</div>:null}</div>):<div className="empty">Nothing has been published from this meeting.</div>}</div>:null}
 </>;
}
