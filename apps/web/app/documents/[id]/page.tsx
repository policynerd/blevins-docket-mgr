'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../../../lib/api';

type Status = { kind: 'idle' | 'saving' | 'saved' | 'error'; text: string };

/**
 * The drafting view.
 *
 * The document is rendered from the server's own AKN-to-HTML, the same
 * function the exporter uses, so what the drafter edits is what will print.
 * Leaf elements carrying text are made editable in place; everything
 * structural is not, because restructuring an instrument is a different act
 * from wording it and should not be one stray keystroke away.
 *
 * A save sends the element's identifier and its new text, never a document.
 */
export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [html, setHtml] = useState<string>();
  const [title, setTitle] = useState('');
  const [label, setLabel] = useState('');
  const [guidance, setGuidance] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [error, setError] = useState<string>();
  const paper = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api
      .documentHtml(id)
      .then((d) => {
        setHtml(d.html);
        setTitle(d.document.title);
        setLabel(d.version.label);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  // Editable leaves are marked after each render of the document HTML. Only
  // elements whose children are pure text qualify: an element containing other
  // elements would have its structure flattened by an edit.
  useEffect(() => {
    const root = paper.current?.querySelector('.akn');
    if (!root) return;
    const EDITABLE = ['aknP', 'heading', 'num', 'docPurpose', 'docType', 'docStage', 'guidance'];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(EDITABLE.join(',')))) {
      if (!el.id) continue;
      if (Array.from(el.children).length > 0) continue;
      el.setAttribute('data-editable', 'true');
      el.setAttribute('contenteditable', 'plaintext-only');
      el.spellcheck = true;
    }
  }, [html]);

  async function commit(event: React.FocusEvent<HTMLDivElement>) {
    const el = event.target as HTMLElement;
    if (!el.hasAttribute('data-editable')) return;
    const elementId = el.id;
    const value = el.textContent ?? '';
    if (value === el.dataset['committed']) return;

    setStatus({ kind: 'saving', text: 'Saving…' });
    try {
      const saved = await api.editElement(id, elementId, value);
      el.dataset['committed'] = value;
      setLabel(saved.label);
      setStatus({ kind: 'saved', text: `Saved ${saved.label}` });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (html === undefined) return <div className="empty">Loading…</div>;

  return (
    <>
      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'var(--text-2xl)' }}>{title}</h1>
          <div className="ref">{label}</div>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={guidance}
            onChange={(e) => setGuidance(e.target.checked)}
          />
          Drafting guidance
        </label>
        <span className={`status ${status.kind}`}>{status.text}</span>
      </div>

      <div ref={paper} className={`paper${guidance ? ' show-guidance' : ''}`} onBlur={commit}>
        <div className="akn" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </>
  );
}
