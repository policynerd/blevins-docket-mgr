import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';
import { parse, serialize, toHtml } from '@blevins/akn';
import { findChromium } from '@blevins/pdf';

import { TEMPLATES, findTemplate } from '../src/templates.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cssDir = join(here, '..', '..', '..', 'packages', 'pdf', 'src', 'css');

function css(name: string): string {
  try {
    return readFileSync(join(cssDir, name), 'utf8');
  } catch {
    throw new Error(
      `Could not read ${name} from ${cssDir}. The stylesheets moved; this test locates them by relative path.`,
    );
  }
}

let browser: Browser | null = null;
async function page(body: string, stylesheets: readonly string[]) {
  browser ??= await chromium.launch({ executablePath: findChromium() });
  const p = await browser.newPage();
  await p.setContent(
    `<!doctype html><html><head><style>${stylesheets.map(css).join('\n')}</style></head><body>${body}</body></html>`,
    { waitUntil: 'load' },
  );
  return p;
}

after(async () => {
  await browser?.close();
});

test('every template document is well-formed Akoma Ntoso that survives a round trip', () => {
  for (const template of TEMPLATES) {
    assert.ok(template.documents.length > 0, `${template.id} has no documents`);
    for (const doc of template.documents) {
      // parse() throws rather than returning a partial tree, so a malformed
      // starting document fails here instead of at a drafter's first save.
      const tree = parse(doc.xml, doc.docType);
      assert.equal(
        serialize(tree),
        doc.xml,
        `${template.id}/${doc.docType} does not round-trip through parse and serialize`,
      );
    }
  }
});

test('a proposal is instantiated as a package of parts, not one document', () => {
  const ord = findTemplate('ORD-STD');
  assert.ok(ord, 'ORD-STD is missing');
  assert.deepEqual(
    ord.documents.map((d) => d.docType),
    ['COVER_PAGE', 'EXPL_MEMORANDUM', 'LEGAL_ACT', 'FINANCIAL_STATEMENT'],
    'the ordinance package no longer holds the four parts it is meant to',
  );
});

test('every unfilled section states that it is unfilled and says what belongs there', () => {
  const letter = findTemplate('ORD-STD')!.documents.find((d) => d.docType === 'EXPL_MEMORANDUM')!;
  const sections = letter.xml.match(/<tblock\b/g) ?? [];
  const guidance = letter.xml.match(/<guidance\b/g) ?? [];
  const placeholders = letter.xml.match(/>Not Applicable</g) ?? [];

  assert.ok(sections.length >= 5, 'the board letter lost its sections');
  // An empty section is indistinguishable from one nobody has reached yet, and
  // a section with no guidance leaves the drafter to guess.
  assert.equal(guidance.length, sections.length, 'a section is missing its drafting guidance');
  assert.equal(placeholders.length, sections.length, 'a section renders as nothing when unfilled');
});

test('drafting guidance never reaches the exported instrument', async () => {
  const letter = findTemplate('ORD-STD')!.documents.find((d) => d.docType === 'EXPL_MEMORANDUM')!;
  const body = toHtml(parse(letter.xml, letter.docType));

  const exported = await page(body, ['act.css']);
  try {
    const shown = await exported.evaluate(
      () =>
        [...document.querySelectorAll('guidance')].filter(
          (el) => getComputedStyle(el).display !== 'none',
        ).length,
    );
    const total = await exported.evaluate(() => document.querySelectorAll('guidance').length);

    assert.ok(total > 0, 'the document under test carries no guidance, so this proves nothing');
    // The export stylesheet hides guidance rather than anything stripping it on
    // the way out. Stripping is a step somebody has to remember; the once it is
    // forgotten, drafting instructions are published inside a legal instrument.
    assert.equal(shown, 0, `${shown} guidance notes would have printed in the exported document`);
  } finally {
    await exported.close();
  }
});

test('the drafting view shows the guidance the export hides', async () => {
  const letter = findTemplate('ORD-STD')!.documents.find((d) => d.docType === 'EXPL_MEMORANDUM')!;
  const body = toHtml(parse(letter.xml, letter.docType));

  const drafting = await page(body, ['act.css', 'guidance.css']);
  try {
    const hidden = await drafting.evaluate(
      () =>
        [...document.querySelectorAll('guidance')].filter(
          (el) => getComputedStyle(el).display === 'none',
        ).length,
    );
    const total = await drafting.evaluate(() => document.querySelectorAll('guidance').length);

    assert.ok(total > 0, 'the document under test carries no guidance, so this proves nothing');
    assert.equal(hidden, 0, 'guidance stayed hidden in the drafting view, where it is the point');
  } finally {
    await drafting.close();
  }
});
