'use client';

import { useEffect, useState } from 'react';

import { api, type Meeting } from '../../lib/api';

export default function MeetingsPage() {
  const [rows, setRows] = useState<Meeting[]>();
  const [bodies, setBodies] = useState<string[]>([]);
  const [error, setError] = useState<string>();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState('Board of Governors');
  const [when, setWhen] = useState('');
  const [location, setLocation] = useState('4895 Executive Drive, Board Chambers | B 250');

  useEffect(() => {
    api.meetings().then(setRows).catch((e: Error) => setError(e.message));
    api
      .legistarCatalog()
      .then((c) => {
        setBodies(c.bodies);
        setBody(c.bodies[1] ?? c.bodies[0] ?? 'Board of Governors');
      })
      .catch(() => {});
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const meeting = await api.createMeeting({
        body,
        meetingAt: new Date(when).toISOString(),
        location,
      });
      window.location.href = `/meetings/${meeting.id}`;
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>Calendar</h1>
          <div className="ref">Meetings and agendas — generate from files In Control of this body</div>
        </div>
        <button className="primary" onClick={() => setOpen(true)}>
          New meeting
        </button>
      </div>
      {error ? <div className="error">{error}</div> : null}
      {open ? (
        <form className="card" style={{ padding: 'var(--space-5)', marginBottom: 'var(--space-5)' }} onSubmit={create}>
          <div className="field">
            <span>Body</span>
            <select value={body} onChange={(e) => setBody(e.target.value)}>
              {bodies.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <span>Date and time</span>
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
          </div>
          <div className="field">
            <span>Location</span>
            <input type="text" value={location} onChange={(e) => setLocation(e.target.value)} />
          </div>
          <button className="primary">Create</button>
          <button type="button" onClick={() => setOpen(false)}>
            Cancel
          </button>
        </form>
      ) : null}
      <div className="card">
        {rows === undefined && !error ? <div className="empty">Loading…</div> : null}
        {rows?.length === 0 ? <div className="empty">No meetings yet.</div> : null}
        {rows?.map((m) => (
          <a key={m.id} className="row" href={`/meetings/${m.id}`}>
            <div className="title">{m.body}</div>
            <div className="meta">
              {new Date(m.meetingAt).toLocaleString()} · Agenda {m.agendaStatus}
              {m.location ? ` · ${m.location}` : ''}
            </div>
            <div className="hint">Open agenda</div>
          </a>
        ))}
      </div>
    </>
  );
}
