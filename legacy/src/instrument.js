'use strict';

const { db } = require('./db');

const DEFAULT_FORMULA = 'HAS ADOPTED THIS RESOLUTION:';

function parseCitations(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function parseRecitals(text) {
  const recitals = [];
  const raw = String(text || '').trim();
  if (!raw) return recitals;
  const chunks = raw.split(/\n\s*(?=\(\d+\))/);
  for (const chunk of chunks) {
    const m = chunk.trim().match(/^\((\d+)\)\s*([\s\S]*)$/);
    if (m) recitals.push({ n: Number(m[1]), text: m[2].trim() });
    else if (chunk.trim()) recitals.push({ n: recitals.length + 1, text: chunk.trim() });
  }
  return recitals;
}

function validate({ citations, recitals, articles }) {
  const issues = [];
  const cites = parseCitations(citations);
  const rec = parseRecitals(recitals);
  if (!cites.length) {
    issues.push({ level: 'warn', msg: 'An act states its legal basis. Add at least one citation beginning “Having regard to”.' });
  }
  for (const c of cites) {
    if (!/^having regard to\b/i.test(c) && !/^after consulting\b/i.test(c)) {
      issues.push({ level: 'info', msg: `Citation is not in Guide form: “${c.slice(0, 80)}”` });
    }
  }
  if (!rec.length) {
    issues.push({ level: 'warn', msg: 'Recitals state why the act is adopted. Number them (1), (2), …' });
  }
  for (const r of rec) {
    if (/\b(hereby|shall|is enacted|is adopted)\b/i.test(r.text)) {
      issues.push({ level: 'warn', msg: `Recital (${r.n}) reads as an enacting term. Reasons belong in recitals; obligations belong in articles.` });
    }
  }
  if (!String(articles || '').trim()) {
    issues.push({ level: 'error', msg: 'There are no enacting terms. Write the articles (or SECTION 1. if that is the house style).' });
  }
  return issues;
}

function compose({ citations, recitals, formula, articles }) {
  const cites = parseCitations(citations);
  const rec = parseRecitals(recitals);
  const parts = [];
  if (cites.length) parts.push(cites.join('\n'));
  if (rec.length) {
    parts.push('Whereas:');
    parts.push(rec.map((r) => `(${r.n}) ${r.text}`).join('\n\n'));
  }
  parts.push(String(formula || DEFAULT_FORMULA).trim() || DEFAULT_FORMULA);
  if (articles) parts.push(String(articles).trim());
  return parts.filter(Boolean).join('\n\n');
}

function get(matterId) {
  const row = db.prepare(`SELECT citations, recitals, enacting_formula, full_text FROM matters WHERE id = ?`).get(matterId);
  if (!row) return null;
  return {
    citations: row.citations || '',
    recitals: row.recitals || '',
    formula: row.enacting_formula || DEFAULT_FORMULA,
    articles: row.full_text || '',
  };
}

function save(matterId, { citations, recitals, formula }) {
  db.prepare(`UPDATE matters SET citations = ?, recitals = ?, enacting_formula = ?, updated_at = datetime('now') WHERE id = ?`).run(
    citations == null ? null : String(citations),
    recitals == null ? null : String(recitals),
    formula == null ? null : String(formula),
    matterId);
}

const COMMISSION_ROUTE = [
  { name: 'Drafting service', role: 'Drafter' },
  { name: 'Inter-service consultation', role: 'Department' },
  { name: 'Legal Service', role: 'Legal' },
  { name: 'Impact assessment', role: 'Analyst' },
  { name: 'College / Board adoption', role: 'Board' },
];

module.exports = {
  DEFAULT_FORMULA, COMMISSION_ROUTE,
  parseCitations, parseRecitals, validate, compose, get, save,
};
