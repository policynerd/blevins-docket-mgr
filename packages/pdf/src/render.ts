import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Paged.js polyfills the CSS Paged Media and Generated Content for Paged Media
 * specs — `@page` margin boxes, page counters, and `float: footnote` — none of
 * which Chromium implements natively. It rewrites the document into explicit
 * page boxes before we print, which is what lets a footnote land at the foot of
 * the page its marker fell on rather than at the end of the document.
 *
 * The bundled polyfill is reached via the package root rather than as a
 * subpath: pagedjs declares an `exports` map that does not expose `./dist/*`,
 * so `require.resolve('pagedjs/dist/…')` is refused outright.
 */
const PAGEDJS_PATH = join(
  dirname(require.resolve('pagedjs')), // …/pagedjs/src
  '..',
  'dist',
  'paged.polyfill.js',
);

let sharedBrowser: Browser | null = null;

/**
 * Locate the Chromium build to drive.
 *
 * `playwright-core` ships no browsers of its own and resolves them by the exact
 * revision its version expects, so an image that already carries a Chromium
 * under PLAYWRIGHT_BROWSERS_PATH — as this one does — will not be found unless
 * the revisions happen to line up. Scanning the directory keeps the two
 * decoupled: the image can update Chromium without pinning us to a matching
 * playwright release. An explicit CHROMIUM_PATH always wins.
 */
export function findChromium(): string | undefined {
  const explicit = process.env['CHROMIUM_PATH'];
  if (explicit) return explicit;

  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (!root || !existsSync(root)) return undefined;

  const candidates = readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((name) => join(root, name, 'chrome-linux', 'chrome'));

  return candidates.find((path) => existsSync(path));
}

/**
 * Chromium takes a second or so to start, which dwarfs the render itself, so
 * the browser is started once and reused. It is deliberately *not* torn down
 * per render — call `shutdown()` when the process is ending.
 */
let launching: Promise<Browser> | null = null;

async function browser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  // Two renders starting at once would otherwise both see no browser and both
  // launch one; the second assignment wins and the first process is orphaned,
  // unreachable by shutdown(). Sharing the in-flight promise means the losers
  // wait for the winner instead of starting their own.
  if (launching) return launching;
  launching = launchBrowser().finally(() => {
    launching = null;
  });
  return launching;
}

async function launchBrowser(): Promise<Browser> {
  sharedBrowser = await chromium.launch({
    executablePath: findChromium(),
    args: [
      // Chromium's sandbox needs privileges a container image will not have.
      // Safe here because the only content rendered is our own, generated from
      // our own database — never a third-party page.
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  });
  return sharedBrowser;
}

export async function shutdown(): Promise<void> {
  await sharedBrowser?.close();
  sharedBrowser = null;
}

function readCss(name: string): string {
  return readFileSync(join(here, 'css', name), 'utf8');
}

export interface RenderOptions {
  /** HTML fragment produced by `toHtml()` from the AKN tree. */
  body: string;
  /** Stylesheet file names under `src/css`, applied in order. */
  stylesheets?: readonly string[];
  /** Extra CSS appended last, for per-document overrides. */
  extraCss?: string;
  /** Document title, written into the PDF metadata. */
  title?: string;
  /**
   * HTML for the running header on continuation pages.
   *
   * Page one carries its letterhead in the document flow; every page after it
   * gets this instead. Supplied as markup rather than assembled here because
   * what belongs in a running head — a roster, a session, a draft marker — is
   * the caller's business, and this package deliberately knows nothing about
   * the vocabulary it is typesetting.
   */
  runningHead?: string;
}

/**
 * Render one document to PDF bytes.
 *
 * Everything about the visual result is decided by CSS. Nothing in this
 * function knows what an article or a recital is.
 */
export async function renderPdf(options: RenderOptions): Promise<Uint8Array> {
  const css = [...(options.stylesheets ?? ['act.css']).map(readCss), options.extraCss ?? ''].join(
    '\n',
  );

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(options.title ?? 'Document')}</title>
<style>${css}</style>
</head>
<body>${options.runningHead ? `<div class="running-head">${options.runningHead}</div>` : ''}${options.body}</body>
</html>`;

  const page = await (await browser()).newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });

    // Fonts first. Paged.js decides where every page breaks by measuring laid
    // out text, so paginating before the faces are ready measures fallback
    // metrics and then never revisits the decision — the breaks come out
    // subtly wrong and nothing reports an error.
    await page.evaluate(() => document.fonts.ready);

    // Register the completion hook *before* the polyfill loads: it auto-runs
    // on injection, and a hook installed afterwards would be registered
    // against a run that has already started.
    await page.evaluate(() => {
      const w = window as unknown as {
        PagedConfig?: { auto?: boolean; after?: () => void };
        __pagedDone?: boolean;
      };
      w.__pagedDone = false;
      w.PagedConfig = {
        auto: true,
        after: () => {
          w.__pagedDone = true;
        },
      };
    });

    // Paged.js is injected *after* the content is in place: it paginates
    // whatever is in the DOM at the moment it runs, so loading it first would
    // paginate an empty body.
    await page.addScriptTag({ path: PAGEDJS_PATH });

    // Wait for Paged.js to say it has finished, not for evidence that it has
    // started. The first `.pagedjs_page` appears while pagination is still
    // running, so treating it as the signal lets `page.pdf()` capture a
    // document whose later pages are missing or half laid out — and a
    // legislative instrument that silently loses its last pages is the worst
    // failure this renderer could have.
    await page.waitForFunction(
      () => (window as unknown as { __pagedDone?: boolean }).__pagedDone === true,
      undefined,
      { timeout: 60_000 },
    );

    // Paged.js has already drawn the page boxes, margins and running content
    // into the DOM at real physical dimensions. Chromium must therefore add
    // no margins of its own and impose no page size — doing either would
    // scale or clip pages that are already exactly right.
    return await page.pdf({
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
    });
  } finally {
    await page.close();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
