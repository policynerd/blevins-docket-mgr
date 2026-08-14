'use strict';

// Load a codification into the Board Code.
//
// The Code is the one body of text in this system that arrives whole rather
// than accumulating: a board adopts a code, and from then on it is amended one
// measure at a time through the legislative path that already exists. This
// handles the first case only. Everything after adoption should go through a
// matter carrying amending instructions, so the Code's history says which
// measure changed what — an import leaves no such trail and should not be used
// where a measure would do.
//
// Idempotent by citation. Running it twice does not duplicate a section, and
// running it against a Code already in force changes nothing unless asked: a
// re-import that silently overwrote enacted text would erase amendments made
// since, which is the whole record this application exists to keep.

const fs = require('node:fs');
const path = require('node:path');
const repo = require('./repo');

const DEFAULT_SOURCE = path.join(__dirname, '..', 'data', 'blevins-administrative-code.json');

/**
 * @param {object} opts
 * @param {string} [opts.file]     path to the codification JSON
 * @param {boolean} [opts.replace] overwrite the text of sections already present
 * @returns {{inserted:number, skipped:number, updated:number, total:number}}
 */
function importCode({ file = DEFAULT_SOURCE, replace = false } = {}) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  if (!sections.length) throw new Error(`No sections in ${file}`);

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const s of sections) {
    if (!s.citation || !s.heading) {
      throw new Error(`Section missing citation or heading: ${JSON.stringify(s).slice(0, 80)}`);
    }
    const existing = repo.code.byCitation(s.citation);
    if (existing) {
      // A section already in force is left alone. It may have been amended
      // since adoption, and the amendment is the authority — not this file.
      if (!replace) { skipped += 1; continue; }
      repo.code.updateSection(existing.id, {
        heading: s.heading,
        body_text: s.body_text,
        status: existing.status,
        effective_date: existing.effective_date || doc.effective_date || null,
      });
      updated += 1;
      continue;
    }
    repo.code.insertSection({
      citation: s.citation,
      // The citation's own prefix is the Title: §3.24 is Title 3. Stated here
      // rather than left to titleOf(), which reads the hyphenated form this
      // codification does not use.
      title_num: s.title_num || String(s.citation).split('.')[0],
      heading: s.heading,
      body_text: s.body_text || null,
      status: 'Active',
      // enacted_by points at a matter. Adoption predates this system, so there
      // is no file to point at, and inventing one would put a measure in the
      // record that the Board never passed.
      enacted_by: null,
      effective_date: doc.effective_date || null,
    });
    inserted += 1;
  }
  return { inserted, updated, skipped, total: sections.length };
}

module.exports = { importCode, DEFAULT_SOURCE };

if (require.main === module) {
  require('./db').init();
  const replace = process.argv.includes('--replace');
  const r = importCode({ replace });
  console.log(`Board Code import: ${r.inserted} added, ${r.updated} updated, `
    + `${r.skipped} already present, ${r.total} in the file.`);
}
