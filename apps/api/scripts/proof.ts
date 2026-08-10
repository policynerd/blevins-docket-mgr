import { writeFileSync } from 'node:fs';
import { parse, toHtml } from '@blevins/akn';
import { renderPdf, mergePdfs, shutdown } from '@blevins/pdf';
import { TEMPLATES } from '../src/templates.ts';

const withGuidance = process.argv.includes('--guidance');
const id = process.argv.find((a) => a.startsWith('--id='))?.slice(5) ?? 'ORD-STD';
const tpl = TEMPLATES.find((t) => t.id === id)!;
const parts: Uint8Array[] = [];
for (const d of tpl.documents) {
  parts.push(
    await renderPdf({
      body: toHtml(parse(d.xml, d.docType)),
      title: d.title,
      stylesheets: [
        'act.css',
        'tokens.css',
        'denton.css',
        'sterling.css',
        ...(['COVER_PAGE', 'EXPL_MEMORANDUM'].includes(d.docType) ? ['masthead.css'] : []),
        ...(withGuidance ? ['guidance.css'] : []),
      ],
    }),
  );
}
const out = `/tmp/tpl/${id}${withGuidance ? '-guidance' : '-export'}.pdf`;
writeFileSync(out, await mergePdfs(parts));
await shutdown();
console.log('wrote', out, '—', tpl.documents.length, 'documents');
