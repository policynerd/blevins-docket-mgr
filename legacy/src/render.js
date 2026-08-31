'use strict';

/**
 * HTML to PDF, through the browser that is already on the machine.
 *
 * The documents this application prints — the board letter, the minutes, a
 * per-item report — are laid out twice: once as HTML for the screen and once,
 * separately, as absolutely-positioned text in `pdfdoc.js`. Two renderers of
 * one document drift, and they did. The screen and the packet disagreed about
 * what a section looked like, and every column in the printed output had to be
 * built by hand — which is how three head-matter values ended up at x=232.0,
 * 219.4 and 227.7, from code that padded labels with spaces and looked like it
 * was aligning something.
 *
 * A browser already solves paged layout: `@page`, tables, hanging indents,
 * widow and orphan control, running headers. So the printed document becomes
 * the same artifact as the screen one, and the layout code goes away.
 *
 * ## Why not Playwright
 *
 * This application has one runtime dependency, and that is a property worth
 * keeping: it is the reason a rebuilt machine comes up in seconds and the
 * reason there is so little to audit. Playwright would add a browser download
 * of its own, a large dependency tree, and unofficial Alpine support.
 *
 * Node 22 ships a global `WebSocket` and a global `fetch`, and the Chrome
 * DevTools Protocol is a JSON protocol over one socket. Launching a browser
 * and asking it for a PDF is the four calls below. Nothing is added to
 * package.json; the browser is an image concern, installed by the Dockerfile,
 * the same way SQLite is a runtime concern rather than a dependency.
 *
 * ## What this must never do
 *
 * Fail a meeting. If the browser cannot start — a rebuilt image without the
 * package, a machine under memory pressure — every caller falls back to the
 * pdf-lib documents, which stay. `available()` is how a caller asks without
 * paying for a launch, and `RenderUnavailable` is what it throws when asked to
 * do something it cannot.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Thrown when there is no browser to render with. Callers fall back. */
class RenderUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = 'RenderUnavailable';
    this.code = 'RENDER_UNAVAILABLE';
  }
}

// Where a Chromium might be. The env var wins so an operator can point at one
// we have not thought of; the rest are the paths the Alpine package, the
// Debian packages and a local Playwright install actually use.
const CANDIDATES = [
  process.env.CHROMIUM_PATH,
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
].filter(Boolean);

function findBrowser() {
  for (const p of CANDIDATES) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) { /* try the next */ }
  }
  return null;
}

const LAUNCH_TIMEOUT_MS = 20000;
const RENDER_TIMEOUT_MS = 30000;

let browser = null;          // { proc, ws, send, close, userDataDir }
let launching = null;        // in-flight launch, so two callers share one browser
let queue = Promise.resolve(); // renders run one at a time; see render()
let idleTimer = null;

/**
 * Close the browser once nothing has needed it for a while.
 *
 * An open WebSocket is a live handle, so a process that has rendered once will
 * not exit while the browser is still attached — a test run hangs after its
 * last assertion, and a script that prints one document never returns. Keeping
 * the browser warm is worth ~330ms on the next render, and worth nothing at
 * all if it means the process cannot end.
 *
 * The timer is unref'd so it never by itself keeps the loop alive: it fires
 * only while something else is holding the process open, which is exactly the
 * situation it exists to resolve. A server rendering steadily keeps pushing it
 * out and never pays for a relaunch.
 */
const IDLE_MS = 5000;
function armIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { idleTimer = null; shutdown(); }, IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    let nextId = 0;

    const fail = (err) => {
      for (const [, p] of pending) p.reject(err);
      pending.clear();
      reject(err);
    };

    ws.onopen = () => resolve({ ws, send, close });
    ws.onerror = () => fail(new RenderUnavailable('The browser connection failed.'));
    ws.onclose = () => {
      // Every outstanding call is now unanswerable. Rejecting them is the
      // difference between a caller seeing an error and a request hanging
      // until the proxy times it out.
      for (const [, p] of pending) {
        p.reject(new RenderUnavailable('The browser closed mid-render.'));
      }
      pending.clear();
      if (browser && browser.ws === ws) browser = null;
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (!msg.id) return;                       // an event, not a reply
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.method || 'CDP'}: ${msg.error.message}`));
      else p.resolve(msg.result);
    };

    function send(method, params = {}, sessionId) {
      const id = ++nextId;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        try {
          ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId }
            : { id, method, params }));
        } catch (e) {
          pending.delete(id);
          rej(new RenderUnavailable(`The browser would not accept a command: ${e.message}`));
        }
      });
    }

    function close() { try { ws.close(); } catch (_) { /* already gone */ } }
  });
}

async function launch() {
  const bin = findBrowser();
  if (!bin) {
    throw new RenderUnavailable(
      'No Chromium was found. Set CHROMIUM_PATH, or install the chromium package.');
  }
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docket-render-'));
  const proc = spawn(bin, [
    '--headless=new',
    // Containers do not give an unprivileged process the namespaces the
    // sandbox needs. What is rendered here is this application's own markup,
    // already sanitized before it was stored, never a third party's page.
    '--no-sandbox',
    '--disable-gpu',
    // /dev/shm is 64MB in a default container and Chromium will crash against
    // it on a long document. This spends disk instead.
    '--disable-dev-shm-usage',
    '--disable-extensions',
    '--mute-audio',
    '--no-first-run',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const cleanup = () => {
    try { proc.kill('SIGKILL'); } catch (_) { /* already dead */ }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  };

  let wsUrl;
  try {
    // The port was chosen by the browser, and it announces it on stderr. This
    // is the documented way to find it without guessing a port and racing
    // whatever else is on the machine.
    wsUrl = await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(
        () => reject(new RenderUnavailable('The browser did not start in time.')),
        LAUNCH_TIMEOUT_MS);
      proc.stderr.on('data', (d) => {
        buf += d;
        const m = /ws:\/\/[^\s]+/.exec(buf);
        if (m) { clearTimeout(timer); resolve(m[0]); }
      });
      proc.once('error', (e) => {
        clearTimeout(timer);
        reject(new RenderUnavailable(`The browser would not start: ${e.message}`));
      });
      proc.once('exit', (code) => {
        clearTimeout(timer);
        reject(new RenderUnavailable(`The browser exited immediately (code ${code}).`));
      });
    });
  } catch (e) {
    cleanup();
    throw e;
  }

  const conn = await connect(wsUrl).catch((e) => { cleanup(); throw e; });
  const b = {
    proc,
    ws: conn.ws,
    send: conn.send,
    userDataDir,
    close() { conn.close(); cleanup(); },
  };
  // A browser that dies takes its handle with it, so the next render launches
  // a fresh one rather than talking to a socket nobody is listening on.
  proc.once('exit', () => { if (browser === b) browser = null; });
  return b;
}

async function get() {
  if (browser) return browser;
  if (!launching) {
    launching = launch().finally(() => { launching = null; });
  }
  browser = await launching;
  return browser;
}

/**
 * Is there a browser to render with? Answers without launching one.
 *
 * DOCKET_RENDER=off forces every caller down the drawn fallback. That switch
 * is not decoration: it is how an operator whose container came up without the
 * browser package gets predictable output instead of a per-request gamble, and
 * how a test run that is not about rendering avoids paying for one.
 */
function available() {
  if (String(process.env.DOCKET_RENDER || '').toLowerCase() === 'off') return false;
  return findBrowser() != null;
}

/**
 * One document, rendered.
 *
 * Renders are serialized. Chromium will happily hold several pages open, but
 * this runs on a small machine beside the database it is reading, and a packet
 * is a sequence of documents rather than a burst of them — so the simpler
 * thing that cannot exhaust memory is the right one.
 */
function render(html, opts = {}) {
  const run = () => renderOne(html, opts);
  // Chained rather than pooled: each render waits for the one before it, and a
  // failure does not poison the chain for everybody behind it.
  const result = queue.then(run, run);
  queue = result.then(() => undefined, () => undefined);
  // Armed after the render settles either way: a failed render leaves a
  // browser behind exactly as a successful one does.
  result.then(armIdleClose, armIdleClose);
  return result;
}

async function renderOne(html, opts) {
  const b = await get();
  let targetId = null;
  const timer = new Promise((_, rej) => setTimeout(
    () => rej(new Error('The document took too long to render.')), RENDER_TIMEOUT_MS));

  try {
    return await Promise.race([timer, (async () => {
      const t = await b.send('Target.createTarget', { url: 'about:blank' });
      targetId = t.targetId;
      const s = await b.send('Target.attachToTarget', { targetId, flatten: true });
      const sid = s.sessionId;
      await b.send('Page.enable', {}, sid);
      await b.send('Page.setDocumentContent', { frameId: targetId, html }, sid);

      // Wait for what the page still owes us. Everything is inlined, so this
      // is normally instant — but a logo configured as a URL is not, and a PDF
      // printed before its fonts resolve is a PDF set in the fallback face.
      await b.send('Runtime.evaluate', {
        expression: `(async () => {
          if (document.fonts && document.fonts.ready) await document.fonts.ready;
          await Promise.all([...document.images]
            .filter((i) => !i.complete)
            .map((i) => new Promise((r) => {
              i.addEventListener('load', r, { once: true });
              i.addEventListener('error', r, { once: true });
            })));
        })()`,
        awaitPromise: true,
      }, sid);

      const printed = await b.send('Page.printToPDF', {
        printBackground: true,
        // The stylesheet's own @page rules decide the sheet and the margins.
        // Passing sizes here instead would put the page geometry in two places
        // and let them disagree.
        preferCSSPageSize: true,
        displayHeaderFooter: !!opts.headerTemplate || !!opts.footerTemplate,
        headerTemplate: opts.headerTemplate || '<span></span>',
        footerTemplate: opts.footerTemplate || '<span></span>',
      }, sid);
      return Buffer.from(printed.data, 'base64');
    })()]);
  } finally {
    // The tab goes even when the render threw, or a failed document leaks a
    // renderer process for the life of the server.
    if (targetId) {
      try { await b.send('Target.closeTarget', { targetId }); } catch (_) { /* gone */ }
    }
  }
}

/** Shut the browser down. Safe to call when there isn't one. */
function shutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const b = browser;
  browser = null;
  if (b) b.close();
}

// A browser outliving the server is a process nobody will ever reap.
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    shutdown();
    if (sig !== 'exit') process.exit(0);
  });
}

module.exports = { render, available, shutdown, RenderUnavailable, findBrowser };
