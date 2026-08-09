import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../src/parse.ts';
import { serialize } from '../src/serialize.ts';
import { toHtml } from '../src/html.ts';
import { newId, isValidId } from '../src/ids.ts';
import { element, isElement, text, type AknNode } from '../src/types.ts';

// A compact act exercising the structures that actually break naive parsers:
// mixed content with an inline footnote mid-sentence, nested provisions, an
// element whose text contains characters that must survive escaping, and an
// empty element that a browser would otherwise treat as unclosed.
const ACT = `<?xml version="1.0" encoding="UTF-8"?>
<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0"
            xmlns:leos="urn:eu:europa:ec:leos">
  <bill name="DEC">
    <preamble xml:id="pre">
      <citations xml:id="cits">
        <citation xml:id="c1">
          <p xml:id="c1p">Having regard to the opinion of the Board<authorialNote
              xml:id="n1" marker="(1)"><p xml:id="n1p">OJ C 1, p. 1.</p></authorialNote>,</p>
        </citation>
      </citations>
      <recitals xml:id="recs">
        <recital xml:id="r1"><num xml:id="r1n">(1)</num><p xml:id="r1p">Fees &lt; 5 &amp; rising.</p></recital>
      </recitals>
    </preamble>
    <body xml:id="bod">
      <article xml:id="a1">
        <num xml:id="a1n">Article 1</num>
        <heading xml:id="a1h">Scope</heading>
        <paragraph xml:id="a1p1"><content xml:id="a1c1"><p xml:id="a1t1">First.</p></content></paragraph>
      </article>
      <article xml:id="a2"><num xml:id="a2n"/></article>
    </body>
  </bill>
</akomaNtoso>`;

function walk(nodes: readonly AknNode[], visit: (n: AknNode) => void): void {
  for (const n of nodes) {
    visit(n);
    if (isElement(n)) walk(n.children, visit);
  }
}

test('parse: a footnote inside a sentence keeps its position between the text runs', () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  const html = toHtml(doc);
  // The note must sit after "Board" and before the trailing comma. A parser
  // that loses child order relocates it to the end of the paragraph, which
  // silently moves the citation mark off the word it cites.
  assert.match(html, /Board<authorialNote[^>]*>.*?<\/authorialNote>,/s);
});

test('parse: rejects a document that is not Akoma Ntoso rather than returning a partial tree', () => {
  assert.throws(() => parse('<html><body>nope</body></html>', 'LEGAL_ACT'), /Akoma Ntoso/);
});

test('parse: rejects a root element that does not match the declared document type', () => {
  // The act above is a <bill>; asking for an explanatory memorandum's <doc>
  // must fail loudly instead of yielding an empty document.
  assert.throws(() => parse(ACT, 'EXPL_MEMORANDUM'), /Expected <doc>/);
});

test('parse: identifiers are read off xml:id and kept out of the attribute bag', () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  let article: ReturnType<typeof element> | undefined;
  walk([doc.root], (n) => {
    if (isElement(n) && n.name === 'article' && n.id === 'a1') article = n;
  });
  assert.ok(article, 'article a1 was not found');
  assert.equal(article.id, 'a1');
  assert.ok(!('xml:id' in article.attrs), 'xml:id leaked into the attribute bag');
  assert.equal(article.attrs['id'], undefined);
});

test('serialize: escaping runs once — a literal < does not become &amp;lt;', () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  const xml = serialize(doc);
  assert.match(xml, /Fees &lt; 5 &amp; rising\./);
  assert.ok(!xml.includes('&amp;lt;'), 'text was double-escaped on the way out');
});

test('serialize: round-trips through parse without losing elements or ids', () => {
  const first = parse(ACT, 'LEGAL_ACT');
  const second = parse(serialize(first), 'LEGAL_ACT');

  const census = (doc: typeof first) => {
    const names: string[] = [];
    const ids: string[] = [];
    walk([doc.root], (n) => {
      if (isElement(n)) {
        names.push(n.name);
        if (n.id) ids.push(n.id);
      }
    });
    return { names, ids };
  };

  assert.deepEqual(census(second), census(first));
});

test('toHtml: an empty element still gets a closing tag', () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  const html = toHtml(doc);
  // `<num/>` self-closed would be read by a browser as an unclosed open tag
  // and would swallow everything after it into the element.
  assert.match(html, /<num id="a2n"><\/num>/);
  assert.ok(!/<num[^>]*\/>/.test(html), 'a self-closing tag survived into the HTML');
});

test('toHtml: a footnote nested inside a paragraph survives HTML parsing intact', async () => {
  // The regression this guards is not visible in the string output — it happens
  // inside the browser's parser. HTML closes an open <p> the moment another <p>
  // starts, so an un-renamed <p> would end the citation early, promote the note
  // text to a sibling block, and strand the trailing comma on its own line.
  // Asserting on the *parsed* DOM is the only way to catch it.
  const { JSDOM } = await import('jsdom');
  const doc = parse(ACT, 'LEGAL_ACT');
  const html = toHtml(doc);

  assert.ok(!/<p[ >]/.test(html), 'a raw <p> survived into the HTML and will break the parser');
  assert.match(html, /<aknP/, 'paragraphs were not renamed to aknP');

  const dom = new JSDOM(`<!doctype html><body>${html}</body>`);
  const citation = dom.window.document.querySelector('citation > aknP');
  assert.ok(citation, 'the citation paragraph did not survive parsing');
  // The note must still be a descendant of the citation paragraph, and the
  // comma must still be inside it, after the note.
  assert.ok(
    citation.querySelector('authorialNote'),
    'the footnote was torn out of the paragraph by the HTML parser',
  );
  assert.match(citation.textContent ?? '', /,\s*$/, 'the trailing comma was stranded');
});

test('toHtml: elements that collide with real HTML semantics are renamed', () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  const html = toHtml(doc);
  // <body> nested in the document body is dropped by the parser outright.
  assert.ok(!/<body[ >]/.test(html), 'a raw <body> survived into the HTML');
  assert.match(html, /<aknBody/, 'the act body was not renamed');
});

test('toHtml: metadata is dropped from the render tree, not merely hidden', () => {
  const withMeta = `<?xml version="1.0"?>
<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">
  <bill name="DEC">
    <meta><identification><FRBRthis value="secret-internal-ref"/></identification></meta>
    <aknBody xml:id="b"><article xml:id="a"><num xml:id="n">Article 1</num></article></aknBody>
  </bill>
</akomaNtoso>`;
  const html = toHtml(parse(withMeta, 'LEGAL_ACT'));
  assert.ok(!html.includes('secret-internal-ref'), 'metadata reached the render tree');
  assert.ok(!html.includes('<meta'), 'the meta element reached the render tree');
});

test('toHtml: layout-only attributes are carried, editing flags are not', () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  const html = toHtml(doc);
  assert.match(html, /marker="\(1\)"/, 'the footnote marker is needed to render the note');
  assert.ok(!html.includes('leos:'), 'LEOS editing flags leaked into the render tree');
});

test('toHtml: text content is escaped, so drafted prose cannot inject markup', () => {
  const doc = {
    docType: 'LEGAL_ACT' as const,
    root: element('bill', {
      children: [element('p', { id: 'x', children: [text('<script>alert(1)</script>')] })],
    }),
  };
  const html = toHtml(doc);
  assert.ok(!html.includes('<script>'), 'markup survived into the render tree');
  assert.match(html, /&lt;script&gt;/);
});

test('ids: freshly minted identifiers are valid XML names and do not collide', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5000; i++) {
    const id = newId();
    assert.ok(isValidId(id), `${id} is not a valid XML id`);
    assert.ok(!seen.has(id), `duplicate id ${id}`);
    seen.add(id);
  }
});
