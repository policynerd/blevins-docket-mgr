'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { api, type FileHistoryLine, type LegislativeFile, type Proposal } from '../../../lib/api';
import { ClerkDesk } from './clerk-desk';

type Tab = 'overview' | 'text' | 'history' | 'actions' | 'versions' | 'audit';

export default function LegislativeFilePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [proposal, setProposal] = useState<Proposal>();
  const [file, setFile] = useState<LegislativeFile>();
  const [history, setHistory] = useState<FileHistoryLine[]>([]);
  const [milestones, setMilestones] = useState<{ id: string; label: string; createdAt: string }[]>([]);
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string>();
  const load = useCallback(() => {
    api.proposal(id).then(setProposal).catch((e: Error) => setError(e.message));
    api.file(id).then(setFile).catch(() => {});
    api.fileHistory(id).then(setHistory).catch(() => {});
    api.milestones(id).then(setMilestones).catch(() => {});
  }, [id]);
  useEffect(load, [load]);
  if (error) return <div className="error">{error}</div>;
  if (!proposal) return <div className="empty">Loading…</div>;
  const status = file?.status ?? 'Draft';
  const control = file?.inControl ?? 'Office of the General Counsel';
  return (
    <>
      <nav className="trail">
        <a href="/">Legislation</a>
        <span>›</span>
        <span className="here">{proposal.ref}</span>
      </nav>
      <header className="record-hero">
        <div>
          <div className="eyebrow">Legislative File</div>
          <div className="record-number">{proposal.ref}</div>
          <h1>{proposal.title}</h1>
          <div className="record-tags">
            <span>{proposal.templateId}</span>
            <em className={`status-chip status-${status.toLowerCase().replaceAll(' ', '-')}`}>{status}</em>
          </div>
        </div>
        <div className="record-actions">
          <a className="btn" href={`/proposals/${id}/print`}>Official copy</a>
          <a className="btn" href={`/api/proposals/${id}/export.pdf`}>Download PDF</a>
          <a className="btn primary" href={proposal.documents[0] ? `/documents/${proposal.documents[0].id}?proposal=${id}` : '#'}>
            Open drafting workspace
          </a>
        </div>
      </header>
      <div className="record-facts">
        <div><span>In Control</span><strong>{control}</strong></div>
        <div><span>Agenda Date</span><strong>{file?.agendaDate ? new Date(file.agendaDate).toLocaleDateString() : '—'}</strong></div>
        <div><span>Sponsors</span><strong>{file?.sponsors || '—'}</strong></div>
        <div><span>Final Action</span><strong>{file?.finalActionAt ? new Date(file.finalActionAt).toLocaleDateString() : '—'}</strong></div>
        <div><span>Enactment</span><strong>{file?.enactmentNumber || '—'}</strong></div>
      </div>
      <ClerkDesk id={id} proposal={proposal} file={file} onChanged={load} />
      <nav className="tabs record-tabs">
        {(['overview', 'text', 'history', 'actions', 'versions', 'audit'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>
      {tab === 'overview' ? (
        <div className="dashboard-grid">
          <section>
            <h2>Legislative History</h2>
            <div className="card timeline">
              {history.length ? history.slice(0, 8).map((h) => (
                <div className="timeline-row" key={h.id}>
                  <time>{new Date(h.actionAt).toLocaleDateString()}</time>
                  <div>
                    <strong>{h.action}</strong>
                    <p>{h.actionText || h.actionNote || h.actingBody}</p>
                  </div>
                </div>
              )) : <div className="empty">No formal actions have been recorded.</div>}
            </div>
          </section>
        </div>
      ) : null}
      {tab === 'text' ? (
        <div className="card">
          {proposal.documents.map((d) => (
            <a className="row" key={d.id} href={`/documents/${d.id}?proposal=${id}`}>
              <div className="title">{d.title}</div>
              <div className="meta">{d.docType} · {d.version?.label ?? 'No version'}</div>
            </a>
          ))}
        </div>
      ) : null}
      {tab === 'history' || tab === 'actions' ? (
        <div className="card timeline">
          {history.length ? history.map((h) => (
            <div className="timeline-row" key={h.id}>
              <time>{new Date(h.actionAt).toLocaleString()}</time>
              <div>
                <strong>{h.action}</strong>
                <p>{h.actionText || h.actionNote || h.actingBody}</p>
                {h.votes.length ? (
                  <div className="vote-line">
                    {h.votes.map((v) => (
                      <span key={v.memberName}>{v.memberName}: <b>{v.vote}</b></span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )) : <div className="empty">No legislative history yet.</div>}
        </div>
      ) : null}
      {tab === 'versions' ? (
        <div className="card">
          {milestones.length ? milestones.map((m) => (
            <div className="row" key={m.id}>
              <div className="title">{m.label}</div>
              <div className="meta">{new Date(m.createdAt).toLocaleString()}</div>
            </div>
          )) : <div className="empty">No frozen record versions yet.</div>}
        </div>
      ) : null}
      {tab === 'audit' ? (
        <div className="card">
          <div className="empty">Publication and action history above is the current audit trail. Entity-level ledger comes next.</div>
        </div>
      ) : null}
    </>
  );
}
