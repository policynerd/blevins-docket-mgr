import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { renderPdf, shutdown } from '../src/render.ts';

after(async () => {
  await shutdown();
});

const PAGE =
  '<doc name="EXPL_MEMORANDUM"><mainBody><tblock><num>1.</num>' +
  '<heading>OVERVIEW</heading>' +
  '<aknP>Ordinary body copy, for contrast.</aknP></tblock></mainBody></doc>';

/**
 * Whether the PDF carries a font Chromium embedded from a `@font-face`.
 *
 * Chromium writes an embedded CFF face as a Type3 font; a face it resolved
 * from the system is written as a TrueType subset. So the presence of Type3
 * is exactly the question "did our own face load", and nothing else about the
 * page can fake it.
 *
 * Two weaker checks were tried first and both passed while the face was
 * broken. Comparing drawn widths fails because a face that never loads still
 * leaves the heading's weight applied to the fallback, which changes the
 * width. Counting distinct faces fails because the fallback chain is a sans
 * and the body is a serif, so a heading that fell back is still a second
 * face.
 */
function embedsCustomFace(bytes: Uint8Array): boolean {
  return Buffer.from(bytes).includes('/Type3');
}

test('the display face loads rather than silently falling back', async () => {
  // The face is inlined as a data URI and applied by a stylesheet each caller
  // has to remember to include. Twice while wiring this up it was added in one
  // place and not another; the page set in the fallback, nothing reported a
  // problem, and it simply looked slightly wrong.
  const withFace = await renderPdf({ body: PAGE, stylesheets: ['act.css', 'sterling.css'] });
  assert.ok(
    embedsCustomFace(withFace),
    'no embedded face in the output — the display face did not load and the heading fell back',
  );
});

test('body copy sets in the document face, borrowing no punctuation from the system', async () => {
  // Denton Text carries the whole of printable ASCII, so a line dense with
  // punctuation must draw entirely in embedded faces. The Sterling trial
  // cannot do this — no parenthesis, semicolon or hyphen — and a document that
  // borrows those from the system is visibly setting in two typefaces.
  //
  // Asserted as "no system font present" rather than "one font used". Chromium
  // splits a single embedded face into several subsets — the em dash lands in
  // its own — so counting fonts, or counting the ids pdf.js assigns them,
  // reports two faces where there is one typeface.
  const punctuated =
    '<doc name="EXPL_MEMORANDUM"><mainBody><aknP>' +
    'Section 4(a); see also thirty (30) days — per Stanton-Blevins, "as adopted".' +
    '</aknP></mainBody></doc>';
  const bytes = await renderPdf({
    body: punctuated,
    stylesheets: ['act.css', 'tokens.css', 'denton.css'],
  });

  const raw = Buffer.from(bytes);
  assert.ok(raw.includes('/Type3'), 'the document face was not embedded at all');
  // Chromium writes a system face as a named TrueType subset; an embedded one
  // has no such name. Any of these appearing means a glyph fell through.
  for (const system of ['Liberation', 'DejaVu', 'Nimbus', 'FreeSerif']) {
    assert.ok(
      !raw.includes(system),
      `${system} appears in the output — a glyph fell back to a system face`,
    );
  }
});

test('a page that asks for no display face embeds none', async () => {
  // Guards the check itself: if every render carried an embedded face, the
  // assertion above would hold whether or not the stylesheet did anything.
  const plain = await renderPdf({ body: PAGE, stylesheets: ['act.css'] });
  assert.ok(
    !embedsCustomFace(plain),
    'an embedded face appeared without the stylesheet that supplies one',
  );
});
