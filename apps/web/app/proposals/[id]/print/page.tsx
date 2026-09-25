'use client';

import { use, useEffect, useState } from 'react';

import { api, type Proposal } from '../../../../lib/api';

export default function OfficialCopyPage({ params }: { params: Promise<{ id: string }> }) {
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
  if (!proposal) return <div className="empty">Loading official copy…</div>;

  const issued = new Date(proposal.updatedAt).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  return (
    <>
      <nav className="trail">
        <a href={`/proposals/${id}`}>{proposal.ref}</a>
        <span aria-hidden>›</span>
        <span className="here">Official copy</span>
      </nav>
      <div className="letter-actions">
        <a className="btn" href={`/proposals/${id}`}>
          File record
        </a>
        <a className="btn primary" href={`/api/proposals/${id}/export.pdf`}>
          Download PDF
        </a>
      </div>
      <article className="letter">
        <p className="letter-office">Blevins Holdings Board of Governors</p>
        <p className="letter-division">Office of the General Counsel</p>
        <div className="letter-meta">
          <span>{proposal.ref}</span>
          <span>{issued}</span>
        </div>
        <p className="letter-to">
          <strong>TO:</strong> The Board of Governors
        </p>
        <p className="letter-subject">
          <strong>SUBJECT:</strong> {proposal.title}
        </p>
        {pages.map((page) => (
          <section key={page.title} className="letter-part">
            <h2>{page.title}</h2>
            <div className="akn" dangerouslySetInnerHTML={{ __html: page.html }} />
          </section>
        ))}
        <p className="letter-updated">Last update: {issued}</p>
      </article>
    </>
  );
}
