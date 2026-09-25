'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, type LegislativeFile, type MeetingDetail } from '../../../lib/api';

type Tab = 'agenda' | 'actions' | 'record' | 'publications';

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [row, setRow] = useState<MeetingDetail>();
  const [files, setFiles] = useState<LegislativeFile[]>([]);
  const [pick, setPick] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>('agenda');
  const load = useCallback(() => api.meeting(id).then(setRow).catch((e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    load();
    api.files().then(setFiles).catch(() => {});
  }, [load]);
  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (error && !row) return <div className="error">{error}</div>;
  if (!row) return <div className="empty">Loading…</div>;
  const published = row.agendaStatus === 'Final';
  return (
    <>
      <nav className="trail">
        <a href="/meetings">Meetings</a>
        <span>›</span>
        <span className="here">{row.body}</span>
      </nav>
      <header className="record-hero">
        <div>
          <div className="eyebrow">Meeting Record</div>
          <h1>{row.body}</h1>
          <div className="ref">{new Date(row.meetingAt).toLocaleString()} · {row.status?.replaceAll('_', ' ') ?? 'Scheduled'} · Agenda v{row.agendaVersion ?? 1}</div>
        </div>
        <div className="record-actions">
          <button onClick={() => act(() => api.generateAgenda(id))} disabled={busy}>Generate from files in control</button>
          {!published ? (
            <button className="primary" onClick={() => act(() => api.publishAgenda(id, 'Final'))} disabled={busy}>Publish agenda</button>
          ) : (
            <button className="primary" onClick={() => {
              const reason = window.prompt('Reason for amended agenda');
              if (reason) void act(() => api.amendAgenda(id, reason));
            }} disabled={busy}>Create amended agenda</button>
          )}
        </div>
      </header>
      {error ? <div className="error">{error}</div> : null}
      <nav className="tabs record-tabs">
        {(['agenda', 'actions', 'record', 'publications'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'agenda' ? (
        <>
          <form
            className="card"
            style={{ padding: '1rem', marginBottom: '1rem' }}
            onSubmit={(e) => {
              e.preventDefault();
              if (pick) void act(() => api.addAgendaItem(id, { proposalId: pick }));
            }}
          >
            <label className="field">
              <span>Add a file to this agenda</span>
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Select a legislative file</option>
                {files.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.ref} — {f.title}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary" disabled={busy || !pick}>Add item</button>
          </form>
          <div className="card">
            {row.items.length ? row.items.map((item, i) => (
              <div className="row" key={item.id}>
                {item.proposalId ? (
                  <a href={`/proposals/${item.proposalId}`}>
                    <div className="title">{i + 1}. {item.ref} — {item.title}</div>
                    <div className="meta">{item.status}</div>
                  </a>
                ) : (
                  <div className="title">{i + 1}. {item.heading}</div>
                )}
              </div>
            )) : <div className="empty">No agenda items yet. Add a file or generate from files in control of this body.</div>}
          </div>
        </>
      ) : null}
      {tab === 'actions' ? (
        <div className="card">
          <div className="meeting-controls">
            <button onClick={() => act(() => api.meetingEvent(id, 'MEETING_CALLED_TO_ORDER'))}>Call to order</button>
            <button onClick={() => act(() => api.meetingEvent(id, 'ROLL_CALL'))}>Record roll call event</button>
            <button onClick={() => act(() => api.meetingEvent(id, 'MEETING_ADJOURNED'))}>Adjourn</button>
            <button onClick={() => act(() => api.meetingEvent(id, 'MINUTES_ADOPTED'))}>Mark minutes adopted</button>
          </div>
          <p className="ref">Record Aye/No on the legislative file itself. That history attaches to this meeting when the action names it.</p>
        </div>
      ) : null}
      {tab === 'record' ? (
        <div className="card timeline">
          {row.events?.length ? row.events.map((e) => (
            <div className="timeline-row" key={e.id}>
              <time>{new Date(e.occurredAt).toLocaleString()}</time>
              <div><strong>{e.eventType.replaceAll('_', ' ')}</strong></div>
            </div>
          )) : <div className="empty">No meeting events recorded.</div>}
        </div>
      ) : null}
      {tab === 'publications' ? (
        <div className="card">
          {row.publications?.length ? row.publications.map((p) => (
            <div className="row" key={p.id}>
              <div className="title">{p.kind.replaceAll('_', ' ')} · Version {p.version}</div>
              <div className="meta">Published {new Date(p.publishedAt).toLocaleString()}</div>
            </div>
          )) : <div className="empty">Nothing has been published from this meeting.</div>}
        </div>
      ) : null}
    </>
  );
}
