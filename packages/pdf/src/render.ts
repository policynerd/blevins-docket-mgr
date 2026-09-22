import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Browser } from 'playwright-core';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const PAGEDJS_PATH = join(
  dirname(require.resolve('pagedjs')),
  '..',
  'dist',
  'paged.polyfill.js',
);

let sharedBrowser: Browser | null = null;

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

let launching: Promise<Browser> | null = null;
let launches = 0;

export function launchCount(): number {
  return launches;
}

async function browser(): Promise<Browser> {
  if (sharedBrowser?.isConnected()) return sharedBrowser;
  if (launching) return launching;
  launching = launchBrowser().finally(() => {
    launching = null;
  });
  return launching;
}

async function launchBrowser(): Promise<Browser> {
  launches++;
  sharedBrowser = await chromium.launch({
    executablePath: findChromium(),
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-software-rasterizer',
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

function boardMarkCss(): string {
  const candidates = [
    join(here, 'assets', 'board-seal.svg'),
    join(here, 'assets', 'board-lockup-alpha.png'),
    join(here, 'assets', 'board-lockup.png'),
  ];
  const path = candidates.find((p) => existsSync(p));
  if (!path) return '';
  const mime = path.endsWith('.svg') ? 'image/svg+xml' : 'image/png';
  const data = readFileSync(path).toString('base64');
  return `:root { --board-mark: url('data:${mime};base64,${data}'); }`;
}

export interface RenderOptions {
  body: string;
  stylesheets?: readonly string[];
  extraCss?: string;
  title?: string;
  runningHead?: string;
}

export async function renderPdf(options: RenderOptions): Promise<Uint8Array> {
  const css = [
    boardMarkCss(),
    ...(options.stylesheets ?? ['act.css']).map(readCss),
    options.extraCss ?? '',
  ].join('\n');

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
    await page.evaluate(() => document.fonts.ready);
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
    await page.addScriptTag({ path: PAGEDJS_PATH });
    await page.waitForFunction(
      () => (window as unknown as { __pagedDone?: boolean }).__pagedDone === true,
      undefined,
      { timeout: 60_000 },
    );
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
