import { newId } from './ids.ts';
import {
  element,
  isElement,
  text,
  type AknDocument,
  type AknElement,
  type AknNode,
} from './types.ts';

function rewriteRoot(doc: AknDocument, next: (root: AknElement) => AknElement): AknDocument {
  return { docType: doc.docType, root: next(doc.root) };
}

function mapElement(node: AknElement, fn: (n: AknElement) => AknElement): AknElement {
  const mapped = element(node.name, {
    ...(node.id === undefined ? {} : { id: node.id }),
    attrs: { ...node.attrs },
    children: node.children.map((child) => (isElement(child) ? mapElement(child, fn) : child)),
  });
  return fn(mapped);
}

function findFirst(node: AknNode, pred: (el: AknElement) => boolean): AknElement | undefined {
  if (!isElement(node)) return undefined;
  if (pred(node)) return node;
  for (const child of node.children) {
    const hit = findFirst(child, pred);
    if (hit) return hit;
  }
  return undefined;
}

function countNamed(node: AknNode, name: string): number {
  if (!isElement(node)) return 0;
  return (node.name === name ? 1 : 0) + node.children.reduce((n, c) => n + countNamed(c, name), 0);
}

function para(body: string): AknElement {
  return element('aknP', { id: newId(), children: [text(body)] });
}

function heading(body: string): AknElement {
  return element('heading', { id: newId(), children: [text(body)] });
}

function num(body: string): AknElement {
  return element('num', { id: newId(), children: [text(body)] });
}

function guidance(body: string): AknElement {
  return element('guidance', { id: newId(), children: [text(body)] });
}

export function removeElement(doc: AknDocument, id: string): AknDocument {
  if (doc.root.id === id) throw new Error('Cannot delete the document root');
  let found = false;
  const visit = (node: AknNode): AknNode | null => {
    if (!isElement(node)) return node;
    if (node.id === id) {
      found = true;
      return null;
    }
    return element(node.name, {
      ...(node.id === undefined ? {} : { id: node.id }),
      attrs: { ...node.attrs },
      children: node.children.map(visit).filter((c): c is AknNode => c !== null),
    });
  };
  const root = visit(doc.root);
  if (!found || !root || !isElement(root)) throw new Error(`No element ${id} in this document`);
  return { docType: doc.docType, root };
}

function appendTo(doc: AknDocument, pred: (el: AknElement) => boolean, child: AknElement): AknDocument {
  let found = false;
  const root = mapElement(doc.root, (node) => {
    if (found || !pred(node)) return node;
    found = true;
    return element(node.name, {
      ...(node.id === undefined ? {} : { id: node.id }),
      attrs: { ...node.attrs },
      children: [...node.children, child],
    });
  });
  if (!found) throw new Error('No container for that insertion');
  return rewriteRoot(doc, () => root);
}

function ensureNamed(doc: AknDocument, name: string, attrs: Record<string, string> = {}): AknDocument {
  if (findFirst(doc.root, (el) => el.name === name)) return doc;
  const created = element(name, { id: newId(), attrs, children: [] });
  if (name === 'recitals') {
    const preamble = findFirst(doc.root, (el) => el.name === 'preamble');
    if (preamble?.id) return appendTo(doc, (el) => el.id === preamble.id, created);
    const wrap = element('preamble', { id: newId(), children: [created] });
    return appendTo(doc, (el) => el.id === doc.root.id, wrap);
  }
  return appendTo(doc, (el) => el.id === doc.root.id, created);
}

export function addRecital(doc: AknDocument): AknDocument {
  const withRecitals = ensureNamed(doc, 'recitals');
  const n = countNamed(withRecitals.root, 'recital') + 1;
  const recital = element('recital', {
    id: newId(),
    children: [
      num(`(${n})`),
      para('WHEREAS, ____; and'),
      guidance('State a fact the Board relies on. Keep it one sentence.'),
    ],
  });
  return appendTo(withRecitals, (el) => el.name === 'recitals', recital);
}

export function addArticle(doc: AknDocument): AknDocument {
  let working = findFirst(doc.root, (el) => el.name === 'aknBody' || el.name === 'body')
    ? doc
    : ensureNamed(doc, 'aknBody');
  const n = countNamed(working.root, 'article') + 1;
  const article = element('article', {
    id: newId(),
    children: [
      num(`SECTION ${n}.`),
      heading('Untitled'),
      element('paragraph', {
        id: newId(),
        children: [element('content', { id: newId(), children: [para('____')] })],
      }),
      guidance('State the operative rule.'),
    ],
  });
  return appendTo(working, (el) => el.name === 'aknBody' || el.name === 'body', article);
}

export function addMemoSection(doc: AknDocument): AknDocument {
  const working = findFirst(doc.root, (el) => el.name === 'mainBody') ? doc : ensureNamed(doc, 'mainBody');
  const n = countNamed(working.root, 'tblock') + 1;
  const block = element('tblock', {
    id: newId(),
    children: [
      num(`${n}.`),
      heading('UNTITLED'),
      para('Not Applicable'),
      guidance('Replace the heading and the body.'),
    ],
  });
  return appendTo(working, (el) => el.name === 'mainBody', block);
}

export const STRUCTURE_ACTIONS = ['add-recital', 'add-section', 'add-memo-section', 'remove'] as const;
export type StructureAction = (typeof STRUCTURE_ACTIONS)[number];

export function applyStructure(
  doc: AknDocument,
  action: StructureAction,
  elementId?: string,
): AknDocument {
  if (action === 'remove') {
    if (!elementId) throw new Error('elementId is required to delete');
    return removeElement(doc, elementId);
  }
  if (action === 'add-recital') return addRecital(doc);
  if (action === 'add-section') return addArticle(doc);
  return addMemoSection(doc);
}
