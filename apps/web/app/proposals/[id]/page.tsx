'use client';

import { use, useCallback, useEffect, useState } from 'react';

import { api, type Proposal } from '../../../lib/api';

type Tab = 'drafts' | 'milestones' | 'details';

export default function ProposalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [proposal, setProposal] = useState<Proposal>();
  const [milestones, setMilestones] = useState<{ id: string; label: string; createdAt: string }[]>(
    [],
  );
  const [tab, setTab] = useState<Tab>('drafts');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .proposal(id)
      .then(setProposal)
      .catch((e: Error) => setError(e.message));
    api
      .milestones(id)
      .then(setMilestones)
      .catch(() => {});
  }, [id]);

  useEffect(load, [load]);

  async function takeMilestone() {
    const label = window.prompt('Label for this milestone', 'Sent to the Board');
    if (!label) return;
    setBusy(true);
    try {
      await api.createMilestone(id, label);
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!proposal) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>{proposal.title}</h1>
          <div className="ref">
            {proposal.ref} · {proposal.templateId}
          </div>
        </div>
        <button onClick={takeMilestone} disabled={busy}>
          Take milestone
        </button>
        <a
          className="btn"
          href={`/api/proposals/${id}/export.pdf`}
          target="_blank"
          rel="noreferrer"
        >
          Export PDF
        </a>
      </div>

      <nav className="tabs">
        {(['drafts', 'milestones', 'details'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'drafts' ? 'Drafts' : t === 'milestones' ? 'Milestones' : 'Details'}
          </button>
        ))}
      </nav>

      {tab === 'drafts' ? (
        <div className="card">
          {proposal.documents.map((d) => (
            <a key={d.id} className="row" href={`/documents/${d.id}`}>
              <div className="title">{d.title}</div>
              <div className="meta">
                {d.version
                  ? `${d.version.label} · updated ${new Date(d.version.updatedAt).toLocaleString()}`
                  : 'empty'}
              </div>
            </a>
          ))}
        </div>
      ) : null}

      {tab === 'milestones' ? (
        <div className="card">
          {milestones.length === 0 ? (
            <div className="empty">
              No milestones yet. A milestone freezes every document as it stands, so a circulated
              copy stays fixed while drafting continues.
            </div>
          ) : (
            milestones.map((m) => (
              <div key={m.id} className="row">
                <div className="title">{m.label}</div>
                <div className="meta">{new Date(m.createdAt).toLocaleString()}</div>
              </div>
            ))
          )}
        </div>
      ) : null}

      {tab === 'details' ? (
        <div className="card" style={{ padding: 'var(--space-6)' }}>
          <div className="field">
            <span>File number</span>
            {proposal.ref}
          </div>
          <div className="field">
            <span>Template</span>
            {proposal.templateId}
          </div>
          <div className="field">
            <span>Documents</span>
            {proposal.documents.length}
          </div>
        </div>
      ) : null}
    </>
  );
}
