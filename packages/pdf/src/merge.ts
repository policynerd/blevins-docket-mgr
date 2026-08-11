import { PDFDocument } from 'pdf-lib';

/**
 * Concatenate rendered documents into the single PDF a reader receives.
 *
 * A proposal is assembled from parts that are drafted, versioned and rendered
 * independently — cover page, explanatory memorandum, legal act, financial
 * statement, annexes — and they only become one document here, at the end.
 * Rendering them separately is what lets each part carry its own stylesheet
 * and its own page rules; a cover page has no folio and no running header,
 * while the act beneath it has both.
 *
 * LEOS does exactly this, for the same reason (ExportServiceImpl.mergeDocuments).
 */
export async function mergePdfs(parts: readonly Uint8Array[]): Promise<Uint8Array> {
  if (parts.length === 0) throw new Error('Nothing to merge: no rendered parts were supplied.');
  if (parts.length === 1) return parts[0]!;

  const out = await PDFDocument.create();
  for (const part of parts) {
    const src = await PDFDocument.load(part);
    const pages = await out.copyPages(src, src.getPageIndices());
    for (const page of pages) out.addPage(page);
  }
  return out.save();
}
