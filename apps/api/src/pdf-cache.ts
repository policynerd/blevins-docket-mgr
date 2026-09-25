/**
 * The Fed does not render SR letters in the browser when you click the link.
 * SR2606a1.pdf is a finished file. We do the same for a packet whose content
 * hash has not changed: first export still drives Chromium; the next one is a
 * memory hit and returns in milliseconds.
 */

const MAX = 32;
const store = new Map<string, Uint8Array>();

export function pdfCacheGet(key: string): Uint8Array | undefined {
  return store.get(key);
}

export function pdfCacheSet(key: string, bytes: Uint8Array) {
  if (store.size >= MAX) {
    const first = store.keys().next().value;
    if (first) store.delete(first);
  }
  store.set(key, bytes);
}

export function pdfFilename(ref: string): string {
  const safe = ref.replace(/[^A-Za-z0-9._-]+/g, '-');
  return `${safe || 'packet'}.pdf`;
}
