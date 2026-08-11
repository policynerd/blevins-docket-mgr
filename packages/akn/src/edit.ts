import {
  element,
  isElement,
  text,
  type AknDocument,
  type AknElement,
  type AknNode,
} from './types.ts';

/** The concatenated text of an element, ignoring nested markup. */
export function textOf(node: AknNode): string {
  if (!isElement(node)) return node.text;
  return node.children.map(textOf).join('');
}

/**
 * Replace the text of one element, addressed by id.
 *
 * Editing addresses a provision by its stable identifier rather than by
 * position, so a save applies to the clause the drafter was looking at even if
 * something above it moved in the meantime. The element's children are
 * replaced by a single text run: this edits leaves — a paragraph, a heading —
 * and is not a way to restructure a document.
 *
 * Returns a new tree; nothing is mutated, so a failed save cannot leave a
 * half-edited document in memory.
 */
export function setElementText(doc: AknDocument, id: string, value: string): AknDocument {
  let found = false;

  const visit = (node: AknNode): AknNode => {
    if (!isElement(node)) return node;
    if (node.id === id) {
      found = true;
      return element(node.name, {
        ...(node.id === undefined ? {} : { id: node.id }),
        attrs: { ...node.attrs },
        children: value === '' ? [] : [text(value)],
      });
    }
    return element(node.name, {
      ...(node.id === undefined ? {} : { id: node.id }),
      attrs: { ...node.attrs },
      children: node.children.map(visit),
    });
  };

  const root = visit(doc.root) as AknElement;
  if (!found) throw new Error(`No element ${id} in this document`);
  return { docType: doc.docType, root };
}
