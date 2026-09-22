'use client';

import { use, useEffect, useState } from 'react';

import { api, type Proposal } from '../../../../lib/api';

export default function PrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [proposal, setProposal] = useState<Proposal>();
  const [pages, setPages] = useState<{ title: string; html: string }[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    api
      .proposal(id)
      .then(async (p) => {
        setProposal(p);
        const rendered = await Promise.all(
          p.documents.map(async (d) => {
            const body = await api.documentHtml(d.id);
            return { title: d.title, html: body.html };
          }),
        );
        setPages(rendered);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <div className="error">{error}</div>;
  if (!proposal) return <div className="empty">Loading preview…</div>;

  return (
    <>
      <nav className="trail">
        <a href={`/proposals/${id}`}>{proposal.ref}</a>
        <span aria-hidden>›</span>
        <span className="here">On-screen packet</span>
      </nav>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1>{proposal.title}</h1>
          <div className="ref">Readable preview while PDF export is repaired.</div>
        </div>
        <button className="primary" type="button" onClick={() => window.print()}>
          Print this view
        </button>
      </div>
      {pages.map((page) => (
        <section key={page.title} className="paper show-guidance" style={{ marginBottom: '2rem' }}>
          <h2>{page.title}</h2>
          <div className="akn" dangerouslySetInnerHTML={{ __html: page.html }} />
        </section>
      ))}
    </>
  );
}
