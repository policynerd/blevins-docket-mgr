import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { renderPdf, shutdown } from '../src/render.ts';

after(async () => {
  await shutdown();
});

/** Text of each page, via a real PDF parser rather than a byte grep. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js rejects a Buffer; renderPdf returns whatever Playwright gave it.
  const data = new Uint8Array(bytes);
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    // Marked-content items carry no `str`; only text items do.
    out.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  return out;
}

const LONG_BODY =
  '<doc name="EXPL_MEMORANDUM"><mainBody>' +
  Array.from(
    { length: 60 },
    (_, i) =>
      `<tblock><num>${i + 1}.</num><heading>SECTION ${i + 1}</heading>` +
      `<aknP>Body text for section ${i + 1}, long enough that the document runs well past a single page.</aknP></tblock>`,
  ).join('') +
  '</mainBody></doc>';

test('the running head appears on continuation pages and not on the first', async () => {
  const bytes = await renderPdf({
    body: LONG_BODY,
    stylesheets: ['act.css', 'masthead.css'],
    runningHead:
      '<container name="masthead"><container name="session">' +
      '<docStage>DRAFT</docStage><docProponent>Regular Session</docProponent>' +
      '<docTitle>August 27, 2026</docTitle></container></container>',
  });

  // Compared case-insensitively: the stylesheet sets the session in small
  // caps via text-transform, so the drawn glyphs are uppercase regardless of
  // how the caller cased it.
  const pages = (await pageTexts(bytes)).map((t) => t.toUpperCase());
  assert.ok(pages.length >= 2, `expected the body to span pages, got ${pages.length}`);

  // Page one carries its letterhead in the flow; repeating the running head
  // there would print the roster twice.
  assert.ok(
    !pages[0]!.includes('REGULAR SESSION'),
    'the continuation header printed on the first page, which already has letterhead',
  );

  // Every page after it has to say which meeting it belongs to — a page pulled
  // from the middle of a packet is read on its own.
  for (const [i, text] of pages.slice(1).entries()) {
    assert.ok(
      text.includes('REGULAR SESSION'),
      `page ${i + 2} is missing the running head that identifies its meeting`,
    );
    assert.ok(text.includes('DRAFT'), `page ${i + 2} does not carry the draft marker`);
  }
});

test('a document with no running head prints none', async () => {
  const bytes = await renderPdf({ body: LONG_BODY, stylesheets: ['act.css', 'masthead.css'] });
  const pages = await pageTexts(bytes);
  assert.ok(pages.length >= 2, 'expected more than one page');
  assert.ok(
    !pages.some((p) => p.includes('DRAFT')),
    'a draft marker appeared on a document that was never given one',
  );
});

test('concurrent first renders share one browser rather than orphaning one', async () => {
  await shutdown();

  // Two renders starting together both find no browser. Without a shared
  // in-flight launch they each start Chromium; the second assignment wins and
  // the first process is left running with nothing able to close it.
  const before = await chromiumProcessCount();
  await Promise.all([
    renderPdf({ body: '<doc name="EXPL_MEMORANDUM"><aknP>One</aknP></doc>' }),
    renderPdf({ body: '<doc name="EXPL_MEMORANDUM"><aknP>Two</aknP></doc>' }),
    renderPdf({ body: '<doc name="EXPL_MEMORANDUM"><aknP>Three</aknP></doc>' }),
  ]);
  const during = await chromiumProcessCount();
  assert.equal(
    during - before,
    1,
    `three concurrent first renders started ${during - before} browsers, not 1`,
  );

  await shutdown();
  const after = await chromiumProcessCount();
  assert.equal(after, before, 'shutdown() left a browser process behind');
});

/**
 * Top-level Chromium processes.
 *
 * One browser is a whole tree of processes — zygote, GPU, one renderer per
 * page — so a plain name match counts six where there is one browser. Only
 * the top-level process lacks a `--type=` argument.
 */
async function chromiumProcessCount(): Promise<number> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  try {
    const { stdout } = await promisify(execFile)('ps', ['-eo', 'args']);
    return stdout.split('\n').filter((line) => {
      // `chrome_crashpad_handler` lives beside the binary and contains the
      // same path, so a substring match counts two crash handlers as two
      // browsers. Require the executable to be exactly `chrome`.
      if (!/chrome-linux\/chrome(\s|$)/.test(line)) return false;
      // Renderer, GPU and zygote children all carry --type=; only the
      // top-level browser process does not.
      return !line.includes('--type=');
    }).length;
  } catch {
    return 0;
  }
}
