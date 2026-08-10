import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { renderPdf, shutdown } from '../src/render.ts';

after(async () => {
  await shutdown();
});

const PAGE =
  '<doc name="EXPL_MEMORANDUM"><mainBody><tblock><num>1.</num>' +
  '<heading>OVERVIEW</heading>' +
  '<aknP>Section 4(a); see also thirty (30) days — per Stanton-Blevins, "as adopted".</aknP>' +
  '</tblock></mainBody></doc>';

test('the document sets in one face, borrowing no punctuation from another', async () => {
  // A line dense with punctuation must draw in a single face. The check that
  // matters is not which face — it is that no glyph fell through to a second
  // one, which is what happened when a face lacked a parenthesis or a hyphen.
  const bytes = await renderPdf({ body: PAGE, stylesheets: ['tokens.css', 'act.css'] });

  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const content = await (await doc.getPage(1)).getTextContent();

  // Body and heading are deliberately different faces — serif and sans — so
  // the body paragraph alone is what must be uniform.
  const bodyFaces = new Set<string>();
  for (const item of content.items) {
    if (!('str' in item) || !('fontName' in item)) continue;
    if (!item.str.includes('Section 4(a)') && !item.str.includes('adopted')) continue;
    bodyFaces.add(item.fontName);
  }
  assert.equal(
    bodyFaces.size,
    1,
    `the body paragraph drew in ${bodyFaces.size} faces; punctuation fell through to another`,
  );
});

test('no font is embedded — the documents use faces the reader already has', async () => {
  // System faces are the point: the Board's own filed documents use them, they
  // add nothing to the file, and they raise no licensing question. An embedded
  // face appearing here means a stylesheet started shipping one again.
  const bytes = await renderPdf({ body: PAGE, stylesheets: ['tokens.css', 'act.css'] });
  assert.ok(
    !Buffer.from(bytes).includes('/Type3'),
    'an embedded font appeared in the output; the documents are meant to use system faces',
  );
});
