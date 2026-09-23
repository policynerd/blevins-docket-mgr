'use client';

import { use, useCallback, useEffect, useState } from 'react';

import { api, type MeetingDetail } from '../../../lib/api';

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [row, setRow] = useState<MeetingDetail>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.meeting(id).then(setRow).catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  async function generate() {
    setBusy(true);
    try {
      setRow(await api.generateAgenda(id));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function publish(status: 'Draft' | 'Final') {
    setBusy(true);
    try {
      setRow(await api.publishAgenda(id, status));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!row) return <div className="empty">Loading…</div>;

  return (
    <>
      <nav className="trail">
        <a href="/meetings">Calendar</a>
        <span aria-hidden>›</span>
        <span className="here">{row.body}</span>
      </nav>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>{row.body}</h1>
          <div className="ref">
            {new Date(row.meetingAt).toLocaleString()} · Agenda {row.agendaStatus}
          </div>
        </div>
        <button onClick={generate} disabled={busy}>
          Generate
        </button>
        {row.agendaStatus === 'Draft' ? (
          <button className="primary" onClick={() => publish('Final')} disabled={busy}>
            Mark final
          </button>
        ) : (
          <button onClick={() => publish('Draft')} disabled={busy}>
            Revert to draft
          </button>
        )}
      </div>
      <p className="ref">{row.location}</p>
      <h2>Agenda</h2>
      <div className="card">
        {row.items.length === 0 ? (
          <div className="empty">
            No items. Generate pulls files whose In Control body matches this meeting and that
            are not yet final.
          </div>
        ) : (
          row.items.map((item, i) => (
            <div key={item.id} className="row">
              {item.proposalId ? (
                <a href={`/proposals/${item.proposalId}`}>
                  <div className="title">
                    {i + 1}. {item.ref} — {item.title}
                  </div>
                  <div className="meta">{item.status}</div>
                </a>
              ) : (
                <div className="title">
                  {i + 1}. {item.heading}
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </>
  );
}
