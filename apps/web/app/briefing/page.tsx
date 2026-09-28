'use client';

import { useEffect, useMemo, useState } from 'react';
import { api, type LegislativeFile, type Meeting, type Publication } from '../../lib/api';

const terminal = new Set(['Adopted', 'Failed', 'Withdrawn', 'Filed', 'Abandoned']);

export default function BriefingPage() {
  const [files, setFiles] = useState<LegislativeFile[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [publications, setPublications] = useState<Publication[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([api.files(), api.meetings(), api.publications()])
      .then(([f, m, p]) => { setFiles(f); setMeetings(m); setPublications(p); })
      .catch((e: Error) => setError(e.message));
  }, []);

  const now = new Date();
  const active = files.filter((f) => !terminal.has(f.status));
  const upcoming = useMemo(
    () => meetings.filter((m) => new Date(m.meetingAt) >= now).sort((a, b) => +new Date(a.meetingAt) - +new Date(b.meetingAt)).slice(0, 5),
    [meetings],
  );
  const agendaReady = active.filter((f) => f.status === 'Ready for Agenda');
  const draftAgendas = upcoming.filter((m) => m.agendaStatus !== 'Final');
  const recentReleases = publications.filter((p) => +new Date(p.publishedAt) >= +now - 7 * 86400000);
  const stale = active
    .filter((f) => +now - +new Date(f.updatedAt) > 14 * 86400000)
    .sort((a, b) => +new Date(a.updatedAt) - +new Date(b.updatedAt))
    .slice(0, 8);

  return (
    <>
      <nav className="trail"><a href="/">Workspace</a><span>›</span><span className="here">Clerk briefing</span></nav>
      <header className="briefing-hero">
        <div><div className="eyebrow">Operations Briefing</div><h1>Clerk Briefing</h1><p className="workspace-lede">A morning-ready snapshot of the legislative queue, calendar, releases, and exceptions.</p></div>
        <div className="briefing-date">{now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</div>
      </header>
      {error ? <div className="error">{error}</div> : null}

      <section className="briefing-grid">
        <article className="brief-card brief-card-wide">
          <div className="brief-head"><div><div className="eyebrow">Calendar</div><h2>Next meetings</h2></div><a href="/meetings">Open calendar</a></div>
          {upcoming.length ? upcoming.map((m) => <a className="brief-meeting" href={'/meetings/' + m.id} key={m.id}>
            <div className="brief-time"><strong>{new Date(m.meetingAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong><span>{new Date(m.meetingAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
            <div><strong>{m.body}</strong><span>{m.location || 'Location not specified'}</span><em className="status-chip">{m.agendaStatus}</em></div>
          </a>) : <div className="empty">No upcoming meetings.</div>}
        </article>

        <article className="brief-card">
          <div className="eyebrow">Queue health</div><h2>What needs attention</h2>
          <a className="brief-stat" href="/docket"><strong>{agendaReady.length}</strong><span>files ready for agenda</span></a>
          <a className="brief-stat" href="/meetings"><strong>{draftAgendas.length}</strong><span>upcoming agendas in draft</span></a>
          <a className="brief-stat" href="/publications"><strong>{recentReleases.length}</strong><span>releases in the last 7 days</span></a>
        </article>

        <article className="brief-card brief-card-wide">
          <div className="brief-head"><div><div className="eyebrow">Exceptions</div><h2>Stale active files</h2></div><span className="ref">14+ days since update</span></div>
          {stale.length ? <div className="exception-list">{stale.map((f) => <a href={'/proposals/' + f.id} className="exception-row" key={f.id}><strong>{f.ref}</strong><span>{f.title}</span><em className="status-chip">{f.status}</em><time>{new Date(f.updatedAt).toLocaleDateString()}</time></a>)}</div> : <div className="empty">No active files have gone stale.</div>}
        </article>

        <article className="brief-card">
          <div className="eyebrow">Release control</div><h2>Recent releases</h2>
          {recentReleases.slice(0, 6).map((p) => <a href="/publications" className="release-row" key={p.id}><strong>v{p.version}</strong><span>{p.kind.replaceAll('_',' ')}</span><time>{new Date(p.publishedAt).toLocaleDateString()}</time></a>)}
          {!recentReleases.length ? <div className="empty">No releases in the last seven days.</div> : null}
        </article>
      </section>

      <div className="brief-footer-actions">
        <a className="btn primary" href="/proposals/new">Start a new file</a>
        <a className="btn" href="/docket">Open today&apos;s docket</a>
        <a className="btn" href="/publications">Review official releases</a>
      </div>
    </>
  );
}