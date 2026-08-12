import { XMLParser } from 'fast-xml-parser';
import {
  ROOT_ELEMENT,
  element,
  text,
  type AknDocument,
  type AknElement,
  type AknNode,
  type DocType,
} from './types.ts';

// Parsing AKN back into the tree.
//
// `preserveOrder` is non-negotiable here. AKN is a mixed-content format — a
// citation paragraph reads "…opinion of the European Parliament<authorialNote/>,"
// where a footnote marker sits *between* two runs of text. The default
// object-shaped parse collapses that into `{ '#text': [...], authorialNote: {} }`
// and loses which run came first, so the marker relocates to the end of the
// sentence. Ordered mode keeps each child as its own positioned entry.

const TEXT_KEY = '#text';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  // A lone `&` in drafted prose is common and is not an entity; leaving it
  // unprocessed here means serialize() re-escapes it correctly on the way out.
  processEntities: true,
});

type OrderedNode = Record<string, unknown>;

function toNodes(entries: readonly OrderedNode[]): AknNode[] {
  const out: AknNode[] = [];

  for (const entry of entries) {
    for (const [name, value] of Object.entries(entry)) {
      if (name === ':@') continue; // attribute sidecar, consumed with its element

      if (name === TEXT_KEY) {
        const raw = String(value);
        // Every non-empty run is kept, including one that is only whitespace.
        //
        // The previous rule dropped blank runs as pretty-printing noise, but
        // this parser is generic — it has no way to know whether the run sits
        // between two blocks or between two inline elements. In
        // `<b>Hello</b> <i>world</i>` the blank run is the only separator
        // there is, and dropping it renders "Helloworld". Extra whitespace
        // between blocks collapses in CSS and costs nothing; a missing space
        // between words is a corrupted document.
        if (raw !== '') out.push(text(raw));
        continue;
      }

      const attrsRaw = (entry[':@'] ?? {}) as Record<string, string>;
      const attrs: Record<string, string> = {};
      let id: string | undefined;

      for (const [attrName, attrValue] of Object.entries(attrsRaw)) {
        const clean = attrName.replace(/^@_/, '');
        if (clean === 'xml:id' || clean === 'id') {
          id = String(attrValue);
        } else {
          attrs[clean] = String(attrValue);
        }
      }

      const children = Array.isArray(value) ? toNodes(value as OrderedNode[]) : [];
      out.push(element(name, { id, attrs, children }));
    }
  }

  return out;
}

/**
 * Parse Akoma Ntoso XML into a document.
 *
 * Throws rather than returning a partial tree: a legislative instrument that
 * silently loses provisions to a malformed parse is far more dangerous than one
 * that refuses to open.
 */
export function parse(xml: string, docType: DocType): AknDocument {
  const parsed = parser.parse(xml) as OrderedNode[];
  const nodes = toNodes(parsed);

  const akomaNtoso = nodes.find(
    (n): n is AknElement => n.kind === 'element' && n.name === 'akomaNtoso',
  );
  if (!akomaNtoso) {
    throw new Error('Not an Akoma Ntoso document: no <akomaNtoso> root element.');
  }

  const expected = ROOT_ELEMENT[docType];
  const root = akomaNtoso.children.find(
    (n): n is AknElement => n.kind === 'element' && n.name === expected,
  );
  if (!root) {
    throw new Error(`Expected <${expected}> beneath <akomaNtoso> for document type ${docType}.`);
  }

  return { docType, root };
}
