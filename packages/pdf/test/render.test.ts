import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { chromium, type Browser } from 'playwright-core';
import { parse, toHtml } from '@blevins/akn';

import { findChromium, renderPdf, shutdown } from '../src/render.ts';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const CSS = readFileSync(join(here, '..', 'src', 'css', 'act.css'), 'utf8');

// An act long enough to run past one page, with a footnote called near the top
// and another called after the break. Page-bottom footnote placement can only
// be tested on a document that actually breaks.
const filler = (n: number) =>
  Array.from(
    { length: n },
    (_, i) =>
      `<article xml:id="a${i}"><num xml:id="an${i}">Article ${i + 1}</num>` +
      `<heading xml:id="ah${i}">Provision ${i + 1}</heading>` +
      `<paragraph xml:id="ap${i}"><content xml:id="ac${i}"><p xml:id="at${i}">` +
      'The Board shall determine the manner in which the foregoing is applied, ' +
      'having regard to the circumstances then prevailing and to the practice ' +
      'of comparable bodies. </p></content></paragraph></article>',
  ).join('');

const ACT = `<?xml version="1.0" encoding="UTF-8"?>
<akomaNtoso xmlns="http://docs.oasis-open.org/legaldocml/ns/akn/3.0">
  <bill name="DEC">
    <preamble xml:id="pre">
      <citations xml:id="cits">
        <citation xml:id="c1"><p xml:id="c1p">Having regard to the founding instrument<authorialNote
          xml:id="n1" marker="1"><p xml:id="n1p">FIRST-NOTE-TEXT</p></authorialNote>,</p></citation>
      </citations>
    </preamble>
    <body xml:id="bod">
      ${filler(14)}
      <article xml:id="zz"><num xml:id="zzn">Article 99</num>
        <paragraph xml:id="zzp"><content xml:id="zzc"><p xml:id="zzt">A late clause<authorialNote
          xml:id="n2" marker="2"><p xml:id="n2p">SECOND-NOTE-TEXT</p></authorialNote>.</p></content></paragraph>
      </article>
    </body>
  </bill>
</akomaNtoso>`;

let browser: Browser | null = null;

/**
 * Lay the document out exactly as `renderPdf` does and return, for each
 * resulting page box, the body text and the footnote text on that page.
 *
 * Inspecting the paginated DOM rather than the finished PDF is deliberate: a
 * PDF gives text and coordinates but not the structure that says "this run is
 * a footnote," so the assertion would degrade into guessing from y-positions.
 */
async function paginate(xml: string): Promise<{ body: string; notes: string }[]> {
  browser ??= await chromium.launch({
    executablePath: findChromium(),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const doc = parse(xml, 'LEGAL_ACT');
  const page = await browser.newPage();
  try {
    await page.setContent(
      `<!doctype html><html><head><style>${CSS}</style></head><body>${toHtml(doc)}</body></html>`,
      { waitUntil: 'load' },
    );
    await page.addScriptTag({
      path: join(
        dirname(require.resolve('pagedjs')),
        '..',
        'dist',
        'paged.polyfill.js',
      ),
    });
    await page.waitForFunction(
      () => document.querySelectorAll('.pagedjs_page').length > 0,
      undefined,
      { timeout: 30_000 },
    );
    return await page.evaluate(() =>
      [...document.querySelectorAll('.pagedjs_page')].map((p) => ({
        body: (p.querySelector('.pagedjs_page_content') as HTMLElement | null)?.innerText ?? '',
        notes: (p.querySelector('.pagedjs_footnote_area') as HTMLElement | null)?.innerText ?? '',
      })),
    );
  } finally {
    await page.close();
  }
}

after(async () => {
  await browser?.close();
  await shutdown();
});

test('a footnote prints at the foot of the page its marker falls on', async () => {
  const pages = await paginate(ACT);
  assert.ok(pages.length >= 2, `expected the act to break across pages, got ${pages.length}`);

  const callPage = pages.findIndex((p) => p.body.includes('founding instrument'));
  const latePage = pages.findIndex((p) => p.body.includes('A late clause'));
  assert.ok(callPage >= 0 && latePage >= 0, 'both footnote calls should appear in the body');
  assert.ok(latePage > callPage, 'the second call should land on a later page than the first');

  assert.match(
    pages[callPage]!.notes,
    /FIRST-NOTE-TEXT/,
    "the first note did not print on its own call's page",
  );
  assert.match(
    pages[latePage]!.notes,
    /SECOND-NOTE-TEXT/,
    "the second note did not print on its own call's page",
  );

  // The decisive check: a note must not bleed onto a page its call never
  // reached. Collecting notes as endnotes at the end of the document — which
  // is what LEOS's own PDF export does — fails exactly here.
  assert.ok(
    !pages[callPage]!.notes.includes('SECOND-NOTE-TEXT'),
    'a later page\'s note printed on an earlier page',
  );
  assert.ok(
    !pages[latePage]!.notes.includes('FIRST-NOTE-TEXT'),
    "an earlier page's note followed the text onto a later page",
  );
});

test('footnote text is never left in the body flow', async () => {
  const pages = await paginate(ACT);
  for (const [i, page] of pages.entries()) {
    assert.ok(
      !page.body.includes('FIRST-NOTE-TEXT') && !page.body.includes('SECOND-NOTE-TEXT'),
      `note text was rendered inline in the body of page ${i + 1} instead of being floated to the foot`,
    );
  }
});

test('renderPdf produces a Letter-sized PDF', async () => {
  const doc = parse(ACT, 'LEGAL_ACT');
  const bytes = await renderPdf({ body: toHtml(doc), title: 'Test Act' });
  assert.ok(bytes.length > 1000, 'suspiciously small PDF');
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('latin1'), '%PDF-');

  // 612 x 792 pt is US Letter. A page box of any other size means paged.js and
  // Chromium disagreed about the page, and the output would be scaled or clipped.
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2);
  for (const page of pdf.getPages()) {
    assert.equal(Math.round(page.getWidth()), 612);
    assert.equal(Math.round(page.getHeight()), 792);
  }
});
