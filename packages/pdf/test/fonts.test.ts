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

test('a page that asks for no display face embeds none', async () => {
  // Guards the check itself: if every render carried an embedded face, the
  // assertion above would hold whether or not the stylesheet did anything.
  const plain = await renderPdf({ body: PAGE, stylesheets: ['act.css'] });
  assert.ok(
    !embedsCustomFace(plain),
    'an embedded face appeared without the stylesheet that supplies one',
  );
});
