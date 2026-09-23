'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';

import { api, type Align } from '../../../lib/api';

type Status = { kind: 'idle' | 'saving' | 'saved' | 'error'; text: string };

const ALIGNS: { id: Align; label: string }[] = [
  { id: 'start', label: 'Left' },
  { id: 'center', label: 'Center' },
  { id: 'end', label: 'Right' },
  { id: 'justify', label: 'Justify' },
];

const EDITABLE = ['aknP', 'heading', 'num', 'docPurpose', 'docType', 'docStage', 'guidance', 'p'];

function alignOf(el: HTMLElement): Align {
  const c = el.className;
  if (/\balign-start\b/.test(c)) return 'start';
  if (/\balign-end\b/.test(c)) return 'end';
  if (/\balign-center\b/.test(c)) return 'center';
  return 'justify';
}

function isLeaf(el: HTMLElement): boolean {
  return !Array.from(el.children).some((c) => c.tagName !== 'BR');
}

export default function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [html, setHtml] = useState<string>();
  const [title, setTitle] = useState('');
  const [label, setLabel] = useState('');
  const [guidance, setGuidance] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: 'idle', text: '' });
  const [error, setError] = useState<string>();
  const [proposalId, setProposalId] = useState<string>();
  const [align, setAlign] = useState<Align>('justify');
  const active = useRef<HTMLElement | null>(null);
  const paper = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);

  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('proposal');
    if (q) setProposalId(q);
  }, []);

  const load = useCallback(() => {
    api
      .documentHtml(id)
      .then((d) => {
        setHtml(d.html);
        setTitle(d.document.title);
        setLabel(d.version.label);
        dirty.current = false;
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);

  useEffect(load, [load]);

  useEffect(() => {
    const root = paper.current?.querySelector('.akn');
    if (!root) return;
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (!el.id) continue;
      if (!EDITABLE.includes(el.tagName) && !EDITABLE.includes(el.localName)) continue;
      if (!isLeaf(el)) continue;
      el.setAttribute('data-editable', 'true');
      el.setAttribute('contenteditable', 'true');
      el.spellcheck = true;
      el.dataset['committed'] = el.textContent ?? '';
    }
  }, [html]);

  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, []);

  function remember(el: HTMLElement) {
    active.current = el;
    setAlign(alignOf(el));
  }

  async function persist(el: HTMLElement) {
    const value = el.textContent ?? '';
    if (value === el.dataset['committed']) return false;
    const saved = await api.editElement(id, el.id, value);
    el.dataset['committed'] = value;
    setLabel(saved.label);
    return true;
  }

  async function commit(event: React.FocusEvent<HTMLDivElement>) {
    const el = event.target as HTMLElement;
    if (!el.hasAttribute('data-editable')) return;
    remember(el);
    setStatus({ kind: 'saving', text: 'Saving…' });
    try {
      const changed = await persist(el);
      dirty.current = false;
      setStatus({
        kind: 'saved',
        text: changed ? `Saved ${label || 'draft'}` : 'No change',
      });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  }

  async function saveAll() {
    const root = paper.current?.querySelector('.akn');
    if (!root) return;
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-editable]'));
    setStatus({ kind: 'saving', text: `Saving ${nodes.length} lines…` });
    try {
      let n = 0;
      for (const el of nodes) {
        if (await persist(el)) n += 1;
      }
      dirty.current = false;
      setStatus({ kind: 'saved', text: n ? `Saved ${n} line${n === 1 ? '' : 's'}` : 'Nothing to save' });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  }

  async function applyAlign(next: Align) {
    const el = active.current;
    if (!el?.id) {
      setStatus({ kind: 'error', text: 'Click a line first.' });
      return;
    }
    el.classList.remove('align-start', 'align-end', 'align-center', 'align-justify');
    el.classList.add(`align-${next}`);
    setAlign(next);
    setStatus({ kind: 'saving', text: 'Saving…' });
    try {
      const saved = await api.editElement(id, el.id, undefined, next);
      setLabel(saved.label);
      setStatus({ kind: 'saved', text: `Saved ${saved.label}` });
    } catch (e) {
      setStatus({ kind: 'error', text: (e as Error).message });
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (html === undefined) return <div className="empty">Loading…</div>;

  const backHref = proposalId ? `/proposals/${proposalId}` : '/';

  return (
    <>
      <nav className="trail">
        <a href="/">Files</a>
        <span aria-hidden>›</span>
        {proposalId ? (
          <>
            <a href={backHref}>File</a>
            <span aria-hidden>›</span>
          </>
        ) : null}
        <span className="here">{title}</span>
      </nav>

      <div className="toolbar">
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 'var(--text-2xl)' }}>{title}</h1>
          <div className="ref">{label}</div>
        </div>
        <div className="align-group" role="group" aria-label="Alignment">
          {ALIGNS.map((a) => (
            <button
              key={a.id}
              type="button"
              className={align === a.id ? 'active' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => applyAlign(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={guidance}
            onChange={(e) => setGuidance(e.target.checked)}
          />
          Drafting guidance
        </label>
        <span className={`status ${status.kind}`}>
          {status.text || 'Edit a line. Blur or Save writes it.'}
        </span>
        <button className="primary" type="button" onClick={saveAll}>
          Save
        </button>
        <a className="btn" href={backHref}>
          Back to file
        </a>
      </div>

      <div
        ref={paper}
        className={`paper${guidance ? ' show-guidance' : ''}`}
        onInput={() => {
          dirty.current = true;
          setStatus({ kind: 'idle', text: 'Unsaved changes' });
        }}
        onBlur={commit}
        onFocus={(e) => {
          const el = e.target as HTMLElement;
          if (el.hasAttribute('data-editable')) remember(el);
        }}
      >
        <div className="akn" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </>
  );
}
