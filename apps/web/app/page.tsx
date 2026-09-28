'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { NotSignedIn, api, signIn, type LegislativeFile, type Meeting, type Publication } from '../lib/api';

type Scope = 'active' | 'all';

function chipClass(status: string) {
  return 'status-chip status-' + status.toLowerCase().replaceAll(' ', '-').replaceAll('_', '-');
}

export default function WorkspacePage() {
  const [files, setFiles] = useState<LegislativeFile[]>();
  const [meetings, setMeetings] = useState<Meeting[]>();
  const [publications, setPublications] = useState<Publication[]>();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('active');
  const [needSignIn, setNeedSignIn] = useState(false);
  const [error, setError] = useState<string>();
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    Promise.all([api.files(), api.meetings(), api.publications()])
      .then(([f, m, p]) => { setFiles(f); setMeetings(m); setPublications(p); })
      .catch((e: Error) => {
        if (e instanceof NotSignedIn) setNeedSignIn(true);
        else setError(e.message);
      });
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const now = new Date();
  const activeStatuses = new Set(['Adopted', 'Failed', 'Withdrawn', 'Filed', 'Abandoned']);
  const active = files?.filter((f) => !activeStatuses.has(f.status)) ?? [];
  const ready = active.filter((f) => f.status === 'Ready for Agenda');
  const recent = [...(files ?? [])].sort((a, b) => +new Date(b.updatedAt) - +new Date(a.updatedAt));
  const upcoming = useMemo(
    () => [...(meetings ?? [])].filter((m) => new Date(m.meetingAt) >= now).sort((a, b) => +new Date(a.meetingAt) - +new Date(b.meetingAt)).slice(0, 4),
    [meetings],
  );
  const filtered = useMemo(() => {
    const base = scope === 'active' ? active : (files ?? []);
    const q = query.trim().toLowerCase();
    if (!q) return base.slice(0, 18);
    return base.filter((f) => [f.ref, f.title, f.status, f.inControl, f.sponsors].some((v) => v?.toLowerCase().includes(q))).slice(0, 18);
  }, [active, files, query, scope]);

  if (needSignIn) {
    return (
      <article className="letter" style={{ marginTop: '2rem' }}>
        <img className="letter-seal" src="/brand/seal-on-light.png" alt="" width={88} height={88} />
        <p className="letter-office">Blevins Holdings Board of Governors</p>
        <p className="letter-division">Legislative Information System</p>
        <h1 style={{ textAlign: 'center', fontSize: '1.6rem' }}>Legislative workspace</h1>
        <p>This workspace brings files, meetings, publication status, and clerk actions into one operating view.</p>
        <p className="letter-actions" style={{ justifyContent: 'center' }}><button className="primary" type="button" onClick={() => signIn('/')}>Sign in</button></p>
      </article>
    );
  }

  return (
    <>
      <section className="workspace-hero">
        <div>
          <div className="eyebrow">Clerk Workspace</div>
          <h1>Legislative Operations</h1>
          <p className="workspace-lede">One operating view for intake, agenda control, live meetings, and the official record.</p>
        </div>
        <div className="hero-actions">
          <a className="btn" href="/docket">Today&apos;s docket</a>
          <a className="btn" href="/meetings">Calendar</a>
          <a className="btn" href="/publications">Publication registry</a>
          <a className="btn primary" href="/proposals/new">New legislative file</a>
        </div>
      </section>

      {error ? <div className="error">{error}</div> : null}

      <section className="metric-grid workspace-metrics" aria-label="Workspace metrics">
        <a className="metric metric-link" href="/docket"><span>Active files</span><strong>{active.length}</strong><small>open matters</small></a>
        <a className="metric metric-link" href="/meetings"><span>Upcoming meetings</span><strong>{upcoming.length}</strong><small>next four shown</small></a>
        <a className="metric metric-link" href="/docket"><span>Ready for agenda</span><strong>{ready.length}</strong><small>awaiting placement</small></a>
        <a className="metric metric-link" href="/publications"><span>Official releases</span><strong>{publications?.length ?? 0}</strong><small>immutable records</small></a>
      </section>

      <section className="workspace-grid">
        <div>
          <div className="section-heading">
            <div><div className="eyebrow">Work queue</div><h2>Legislative files</h2></div>
            <span className="ref">{filtered.length} shown</span>
          </div>
          <div className="searchbar workspace-search">
            <span aria-hidden>⌕</span>
            <input ref={searchRef} aria-label="Search legislative files" placeholder="Search file, title, sponsor, status, or control" value={query} onChange={(e) => setQuery(e.target.value)} />
            <kbd>/</kbd>
          </div>
          <div className="segmented" aria-label="File scope">
            <button className={scope === 'active' ? 'active' : ''} onClick={() => setScope('active')}>Active</button>
            <button className={scope === 'all' ? 'active' : ''} onClick={() => setScope('all')}>All files</button>
          </div>
          <div className="record-table card">
            <div className="record-head workspace-record-head"><span>File</span><span>Title</span><span>Status</span><span>Control</span><span>Updated</span></div>
            {files === undefined && !error ? <div className="empty">Loading legislative files…</div> : null}
            {files && filtered.length === 0 ? <div className="empty">No files match this search.</div> : null}
            {filtered.map((f) => (
              <a key={f.id} className="record-line workspace-record-line" href={'/proposals/' + f.id}>
                <strong className="file-ref">{f.ref}</strong>
                <span><b>{f.title}</b>{f.enactmentNumber ? <small>{f.enactmentNumber}</small> : null}</span>
                <span><em className={chipClass(f.status)}>{f.status}</em></span>
                <span>{f.inControl}</span>
                <span>{new Date(f.updatedAt).toLocaleDateString()}</span>
              </a>
            ))}
          </div>
        </div>

        <aside className="workspace-aside">
          <section className="panel">
            <div className="panel-head"><div><div className="eyebrow">Calendar</div><h2>Next meetings</h2></div><a href="/meetings">View all</a></div>
            {upcoming.length ? upcoming.map((m) => (
              <a className="meeting-card" key={m.id} href={'/meetings/' + m.id}>
                <div className="meeting-date"><strong>{new Date(m.meetingAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</strong><span>{new Date(m.meetingAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span></div>
                <div><strong>{m.body}</strong><span>{m.location || 'Location to be determined'}</span><em className="status-chip">{m.agendaStatus}</em></div>
              </a>
            )) : <div className="empty">No future meetings are scheduled.</div>}
          </section>

          <section className="panel">
            <div className="panel-head"><div><div className="eyebrow">Attention</div><h2>Next actions</h2></div></div>
            <a className="action-row" href="/docket"><strong>{ready.length}</strong><span>files ready for agenda placement</span><b>Open queue</b></a>
            <a className="action-row" href="/publications"><strong>{publications?.filter((p) => new Date(p.publishedAt) >= new Date(now.getTime() - 7 * 86400000)).length ?? 0}</strong><span>releases in the last 7 days</span><b>Review registry</b></a>
            <a className="action-row" href="/meetings"><strong>{upcoming.filter((m) => m.agendaStatus !== 'Final').length}</strong><span>upcoming agendas still in draft</span><b>Open calendar</b></a>
          </section>

          <section className="panel">
            <div className="panel-head"><div><div className="eyebrow">Recent</div><h2>Latest activity</h2></div></div>
            {recent.slice(0, 5).map((f) => (
              <a className="activity-row" key={f.id} href={'/proposals/' + f.id}>
                <span className={chipClass(f.status)}>{f.status}</span><strong>{f.ref}</strong><span>{f.title}</span>
              </a>
            ))}
          </section>
        </aside>
      </section>
    </>
  );
}
