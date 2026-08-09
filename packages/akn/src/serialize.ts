import { AKN_NS, LEOS_NS, isElement, type AknDocument, type AknNode } from './types.ts';

// Escaping.
//
// `&` is replaced FIRST and the remaining rules never introduce an `&`, so no
// sequence is escaped twice. Doing it in the other order turns a literal `<`
// into `&amp;lt;` — the classic double-encode, which renders as visible markup
// in the PDF instead of the character the drafter typed.
function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function serializeNode(node: AknNode): string {
  if (!isElement(node)) return escapeText(node.text);

  const attrs: string[] = [];
  if (node.id) attrs.push(`xml:id="${escapeAttr(node.id)}"`);
  for (const [key, value] of Object.entries(node.attrs)) {
    attrs.push(`${key}="${escapeAttr(value)}"`);
  }

  const open = attrs.length ? `${node.name} ${attrs.join(' ')}` : node.name;
  if (node.children.length === 0) return `<${open}/>`;

  const inner = node.children.map(serializeNode).join('');
  return `<${open}>${inner}</${node.name}>`;
}

/** Serialize a document to Akoma Ntoso XML. */
export function serialize(doc: AknDocument): string {
  const body = serializeNode(doc.root);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<akomaNtoso xmlns="${AKN_NS}" xmlns:leos="${LEOS_NS}">` +
    body +
    '</akomaNtoso>'
  );
}
