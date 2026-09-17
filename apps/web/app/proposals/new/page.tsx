'use client';

import { useEffect, useState } from 'react';

import { api, type Template } from '../../../lib/api';

export default function NewProposalPage() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .templates()
      .then((t) => {
        setTemplates(t);
        setTemplateId(t[0]?.id ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const chosen = templates.find((t) => t.id === templateId);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const p = await api.createProposal({ templateId, title });
      const first = p.documents[0];
      window.location.href = first
        ? `/documents/${first.id}?proposal=${p.id}`
        : `/proposals/${p.id}`;
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <>
      <nav className="trail">
        <a href="/">Proposals</a>
        <span aria-hidden>›</span>
        <span className="here">New</span>
      </nav>

      <h1>New proposal</h1>
      <div className="ref">Choose an instrument, then start drafting</div>

      {error ? <div className="error">{error}</div> : null}

      <form
        onSubmit={submit}
        className="card"
        style={{ padding: 'var(--space-5)', marginTop: 'var(--space-5)' }}
      >
        <label className="field">
          <span>Template</span>
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.path.join(' › ')} › {t.name}
              </option>
            ))}
          </select>
        </label>

        {chosen ? (
          <div className="field">
            <span>This opens {chosen.documents.length} draft{chosen.documents.length === 1 ? '' : 's'}</span>
            <div
              className="meta"
              style={{ fontSize: 'var(--text-sm)', color: 'var(--color-ink-3)' }}
            >
              {chosen.documents.map((d) => d.title).join(' · ')}
            </div>
          </div>
        ) : null}

        <label className="field">
          <span>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="An Ordinance Amending the Administrative Code"
            required
          />
        </label>

        <button className="primary" disabled={busy || !templateId || !title}>
          {busy ? 'Opening draft…' : 'Create and start drafting'}
        </button>
      </form>
    </>
  );
}
