'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LegislativeFile, type Meeting } from '../lib/api';

const routes = [
  { href: '/', label: 'Workspace', hint: 'Legislative operations home' },
  { href: '/briefing', label: 'Clerk briefing', hint: 'Queue health and exceptions' },
  { href: '/docket', label: "Today's docket", hint: 'Current work queue' },
  { href: '/meetings', label: 'Meetings', hint: 'Calendar and agendas' },
  { href: '/templates', label: 'Drafting templates', hint: 'Start an instrument' },
  { href: '/publications', label: 'Publication registry', hint: 'Official immutable releases' },
  { href: '/settings', label: 'Administration', hint: 'Deployment and browser settings' },
];

export function CommandMenu() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<LegislativeFile[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    if (!files.length) api.files().then(setFiles).catch(() => {});
    if (!meetings.length) api.meetings().then(setMeetings).catch(() => {});
  }, [open, files.length, meetings.length]);

  const q = query.trim().toLowerCase();
  const routeMatches = routes.filter((r) => !q || (r.label + ' ' + r.hint).toLowerCase().includes(q)).slice(0, 5);
  const fileMatches = useMemo(() => {
    if (!q) return files.slice(0, 5);
    return files.filter((f) => [f.ref, f.title, f.status, f.inControl, f.sponsors].some((v) => v?.toLowerCase().includes(q))).slice(0, 8);
  }, [files, q]);
  const meetingMatches = useMemo(() => {
    if (!q) return meetings.slice(0, 3);
    return meetings.filter((m) => [m.body, m.location, m.agendaStatus].some((v) => v?.toLowerCase().includes(q))).slice(0, 5);
  }, [meetings, q]);

  const go = (href: string) => {
    setOpen(false);
    window.location.href = href;
  };

  return (
    <>
      <button className="command-trigger" type="button" onClick={() => setOpen(true)} aria-label="Open command menu">
        <span>Search</span><kbd>⌘K</kbd>
      </button>
      {open ? (
        <div className="command-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
          <section className="command-dialog" role="dialog" aria-modal="true" aria-label="Command menu" onMouseDown={(e) => e.stopPropagation()}>
            <div className="command-search">
              <span aria-hidden>⌕</span>
              <input ref={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search files, meetings, or go to a workspace…" />
              <kbd>Esc</kbd>
            </div>
            <div className="command-results">
              {routeMatches.length ? <div className="command-group"><h2>Go to</h2>{routeMatches.map((r) => <button key={r.href} onClick={() => go(r.href)}><strong>{r.label}</strong><span>{r.hint}</span></button>)}</div> : null}
              {fileMatches.length ? <div className="command-group"><h2>Legislative files</h2>{fileMatches.map((f) => <button key={f.id} onClick={() => go('/proposals/' + f.id)}><strong>{f.ref} — {f.title}</strong><span>{f.status} · {f.inControl}</span></button>)}</div> : null}
              {meetingMatches.length ? <div className="command-group"><h2>Meetings</h2>{meetingMatches.map((m) => <button key={m.id} onClick={() => go('/meetings/' + m.id)}><strong>{m.body}</strong><span>{new Date(m.meetingAt).toLocaleString()} · {m.agendaStatus}</span></button>)}</div> : null}
              {!routeMatches.length && !fileMatches.length && !meetingMatches.length ? <div className="command-empty">No matching files, meetings, or destinations.</div> : null}
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}