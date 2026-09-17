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
  const [taking, setTaking] = useState(false);
  const [milestoneLabel, setMilestoneLabel] = useState('Sent to the Board');

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

  async function takeMilestone(e?: React.FormEvent) {
    e?.preventDefault();
    const label = milestoneLabel.trim();
    if (!label) return;
    setBusy(true);
    try {
      await api.createMilestone(id, label);
      setTaking(false);
      load();
      setTab('milestones');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!proposal) return <div className="empty">Loading…</div>;

  const drafted = proposal.documents.some((d) => d.version);
  const frozen = milestones.length > 0;
  const firstDoc = proposal.documents[0];

  return (
    <>
      <nav className="trail">
        <a href="/">Proposals</a>
        <span aria-hidden>›</span>
        <span className="here">{proposal.ref}</span>
      </nav>

      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>{proposal.title}</h1>
          <div className="ref">
            {proposal.ref} · {proposal.templateId}
          </div>
        </div>
        <a
          className="btn"
          href={`/api/proposals/${id}/export.pdf`}
          target="_blank"
          rel="noreferrer"
        >
          Export PDF
        </a>
      </div>

      <ol className="process">
        <li className={`step ${drafted ? 'done' : 'next'}`}>
          <span className="n">1</span> Draft
        </li>
        <li className={`step ${frozen ? 'done' : drafted ? 'next' : ''}`}>
          <span className="n">2</span> Freeze a copy
        </li>
        <li className={`step ${frozen ? 'next' : ''}`}>
          <span className="n">3</span> Circulate
        </li>
      </ol>

      {!drafted && firstDoc ? (
        <div className="next-action">
          <strong>Next:</strong> open the first draft and write.
          <a className="btn primary" href={`/documents/${firstDoc.id}?proposal=${id}`}>
            Open {firstDoc.title}
          </a>
        </div>
      ) : null}
      {drafted && !frozen ? (
        <div className="next-action">
          <strong>Next:</strong> freeze a circulated copy so drafting can continue.
          {taking ? (
            <form className="inline-form" onSubmit={takeMilestone}>
              <input
                type="text"
                value={milestoneLabel}
                onChange={(e) => setMilestoneLabel(e.target.value)}
                aria-label="Milestone label"
              />
              <button className="primary" disabled={busy}>
                {busy ? 'Freezing…' : 'Freeze'}
              </button>
              <button type="button" onClick={() => setTaking(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button className="primary" onClick={() => setTaking(true)}>
              Take milestone
            </button>
          )}
        </div>
      ) : null}
      {frozen ? (
        <div className="next-action">
          <strong>Next:</strong> export the packet that leaves the office.
          <a className="btn primary" href={`/api/proposals/${id}/export.pdf`} target="_blank" rel="noreferrer">
            Export PDF
          </a>
        </div>
      ) : null}

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
            <a key={d.id} className="row" href={`/documents/${d.id}?proposal=${id}`}>
              <div className="title">{d.title}</div>
              <div className="meta">
                {d.version
                  ? `${d.version.label} · updated ${new Date(d.version.updatedAt).toLocaleString()}`
                  : 'empty'}
              </div>
              <div className="hint">Continue drafting</div>
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
              <div style={{ marginTop: 'var(--space-4)' }}>
                {taking ? (
                  <form className="inline-form" onSubmit={takeMilestone} style={{ justifyContent: 'center' }}>
                    <input
                      type="text"
                      value={milestoneLabel}
                      onChange={(e) => setMilestoneLabel(e.target.value)}
                      aria-label="Milestone label"
                    />
                    <button className="primary" disabled={busy}>
                      {busy ? 'Freezing…' : 'Freeze'}
                    </button>
                  </form>
                ) : (
                  <button className="primary" onClick={() => setTaking(true)}>
                    Take first milestone
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              {milestones.map((m) => (
                <div key={m.id} className="row">
                  <div className="title">{m.label}</div>
                  <div className="meta">{new Date(m.createdAt).toLocaleString()}</div>
                </div>
              ))}
              <div className="row">
                {taking ? (
                  <form className="inline-form" onSubmit={takeMilestone}>
                    <input
                      type="text"
                      value={milestoneLabel}
                      onChange={(e) => setMilestoneLabel(e.target.value)}
                      aria-label="Milestone label"
                    />
                    <button className="primary" disabled={busy}>
                      {busy ? 'Freezing…' : 'Freeze another'}
                    </button>
                    <button type="button" onClick={() => setTaking(false)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <button onClick={() => setTaking(true)}>Take another milestone</button>
                )}
              </div>
            </>
          )}
        </div>
      ) : null}

      {tab === 'details' ? (
        <div className="card" style={{ padding: 'var(--space-5)' }}>
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
