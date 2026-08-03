'use strict';

// Amending engine — the half of a drafting system that reasons about *change*.
//
// A bill carries amending instructions (add / amend / repeal) that target
// sections of the Board Code. Those instructions are drafted alongside the bill
// and are not applied to the Code until the measure is enacted. Holding them as
// data (rather than as prose buried in the text) is what makes two things
// possible:
//
//   • Comparative print — show current law as it would read if this bill passed,
//     before it passes.
//   • Codification — on enactment, apply the instructions to the Code
//     mechanically, recording the authority and the text they replaced.
//
// The three comparison types mirror the U.S. House Comparative Print Suite:
//   1. document to document  — one draft version against another
//   2. bill vs. current law  — what the bill would do to the Code
//   3. amendment impact      — how a pending amendment would change the bill

const { db } = require('./db');
const repo = require('./repo');
const legisdoc = require('./legisdoc');
const { diffHtml, stats: rawDiffStats } = require('./diff');

// diff.js reports { ins, del } in words; expose it under clearer names.
function diffStats(a, b) {
  const s = rawDiffStats(a, b);
  return { added: s.ins, removed: s.del, ins: s.ins, del: s.del };
}

// What a section would say if this instruction were adopted.
// `repeal` yields null (the section ceases to exist).
function proposedTextFor(amendment, currentText) {
  if (amendment.op === 'repeal') return null;
  if (amendment.op === 'add') return amendment.new_text || '';
  return amendment.new_text == null ? (currentText || '') : amendment.new_text;
}

// --- (2) Bill vs. current law ------------------------------------------------
// For each amending instruction, pair the Code's current text with the text as
// this bill proposes it, and diff the two.
function comparativePrint(matterId) {
  const rows = repo.code.amendments(matterId);
  return rows.map((a) => {
    const section = repo.code.byCitation(a.citation);
    const currentText = section ? (section.body_text || '') : '';
    const proposed = proposedTextFor(a, currentText);
    const isRepeal = a.op === 'repeal';
    // Only a citation that does not yet exist has no "before" side. An `add`
    // aimed at an existing section is an amendment in substance (codify()
    // treats it that way), so the print must still show the replaced text.
    const isAdd = !section;
    return {
      amendment: a,
      citation: a.citation,
      op: a.op,
      heading: a.heading || (section ? section.heading : ''),
      exists: !!section,
      sectionId: section ? section.id : null,
      currentText,
      proposedText: proposed,
      // An added section has no "before"; a repeal has no "after".
      diff: diffHtml(isAdd ? '' : currentText, isRepeal ? '' : (proposed || '')),
      stats: diffStats(isAdd ? '' : currentText, isRepeal ? '' : (proposed || '')),
      // Structural validation of the proposed text.
      issues: proposed ? legisdoc.validate(legisdoc.parse(proposed)) : [],
    };
  });
}

// A one-line summary of a bill's effect on the Code, for headers and lists.
function codeImpact(matterId) {
  const rows = repo.code.amendments(matterId);
  const out = { add: 0, amend: 0, repeal: 0, total: rows.length, titles: [] };
  const titles = new Set();
  for (const a of rows) {
    if (out[a.op] != null) out[a.op]++;
    if (a.title_num) titles.add(a.title_num);
  }
  out.titles = [...titles].sort((x, y) => Number(x) - Number(y));
  return out;
}

// --- (3) Amendment impact ----------------------------------------------------
// How a proposed replacement would change the bill's own text.
function amendmentImpact(baseText, proposedText) {
  return {
    diff: diffHtml(baseText || '', proposedText || ''),
    stats: diffStats(baseText || '', proposedText || ''),
    issues: legisdoc.validate(legisdoc.parse(proposedText || '')),
  };
}

// An instruction must carry usable, structurally sound text before it is
// allowed to touch the Code. Returns an error string, or null when it is fine.
function instructionError(a) {
  if (a.op === 'repeal') return null;
  const text = a.op === 'add' ? a.new_text : a.new_text;
  if (text == null || !String(text).trim()) {
    return `§${a.citation}: ${a.op} carries no text.`;
  }
  const issues = legisdoc.validate(legisdoc.parse(text)).filter((i) => i.level === 'error');
  if (issues.length) return `§${a.citation}: proposed text is not well formed — ${issues[0].msg}`;
  return null;
}

// --- Codification ------------------------------------------------------------
// Apply an enacted measure's instructions to the Code. Records prior text for
// every touched section so the authority trail and point-in-time views work.
//
// Only an enacted measure may change the Code — enforced here rather than at
// the call site so every caller is bound by it. Each instruction is validated
// first and applied inside its own savepoint, so a failure leaves no
// half-written section or orphan history row. Idempotent: instructions already
// applied are skipped.
const ENACTING_STATUSES = new Set(['Passed', 'Enacted', 'Adopted']);

function codify(matterId, { effectiveDate = null, force = false } = {}) {
  const result = { added: 0, amended: 0, repealed: 0, skipped: 0, errors: [] };
  const matter = repo.matters.get(matterId);
  if (!matter) { result.errors.push('Measure not found.'); return result; }
  if (!force && !ENACTING_STATUSES.has(matter.status)) {
    result.errors.push(`Only an enacted measure may change the Code — ${matter.file_number} is ${matter.status}.`);
    return result;
  }

  const rows = repo.code.amendments(matterId).filter((a) => !a.applied_at);

  for (const a of rows) {
    const bad = instructionError(a);
    if (bad) { result.errors.push(bad); result.skipped++; continue; }
    const section = repo.code.byCitation(a.citation);
    db.exec('SAVEPOINT sp_codify');
    try {
      if (a.op === 'add') {
        if (section) {
          // Adding over an existing section is an amendment in substance.
          repo.code.recordHistory({ code_section_id: section.id, matter_id: matterId, op: 'amend',
            prior_text: section.body_text, effective_date: effectiveDate });
          repo.code.updateSection(section.id, {
            heading: a.heading || section.heading, body_text: a.new_text,
            status: 'Active', effective_date: effectiveDate || section.effective_date,
          });
          result.amended++;
        } else {
          const id = repo.code.insertSection({
            citation: a.citation, title_num: a.title_num, heading: a.heading || a.citation,
            body_text: a.new_text, enacted_by: matterId, effective_date: effectiveDate,
          });
          repo.code.recordHistory({ code_section_id: id, matter_id: matterId, op: 'add',
            prior_text: null, effective_date: effectiveDate });
          result.added++;
        }
      } else if (a.op === 'amend') {
        if (!section) { throw new Error(`§${a.citation} not found — cannot amend.`); }
        repo.code.recordHistory({ code_section_id: section.id, matter_id: matterId, op: 'amend',
          prior_text: section.body_text, effective_date: effectiveDate });
        repo.code.updateSection(section.id, {
          heading: a.heading || section.heading,
          body_text: proposedTextFor(a, section.body_text),
          status: 'Active', effective_date: effectiveDate || section.effective_date,
        });
        result.amended++;
      } else if (a.op === 'repeal') {
        if (!section) { throw new Error(`§${a.citation} not found — cannot repeal.`); }
        repo.code.recordHistory({ code_section_id: section.id, matter_id: matterId, op: 'repeal',
          prior_text: section.body_text, effective_date: effectiveDate });
        repo.code.updateSection(section.id, {
          heading: section.heading, body_text: section.body_text,
          status: 'Repealed', effective_date: effectiveDate || section.effective_date,
        });
        result.repealed++;
      }
      repo.code.markApplied(a.id);
      db.exec('RELEASE sp_codify');
    } catch (e) {
      db.exec('ROLLBACK TO sp_codify');
      db.exec('RELEASE sp_codify');
      result.errors.push(e.message.startsWith('§') ? e.message : `§${a.citation}: ${e.message}`);
      result.skipped++;
    }
  }
  return result;
}

// Reconstruct a section's text as of a point in time, by rewinding history.
// Each history row stores the text that was replaced, so walking back from the
// current body yields the text in force before each change.
function asOf(codeSectionId, isoDate) {
  const section = repo.code.get(codeSectionId);
  if (!section) return null;
  const hist = repo.code.historyFor(codeSectionId); // newest first
  // A repealed section retains its body_text for the record, but nothing is in
  // force today — so the walk starts from "absent" and a rewind past the repeal
  // restores the text that stood before it.
  let text = section.status === 'Repealed' ? null : section.body_text;
  for (const h of hist) {
    const when = h.effective_date || (h.created_at || '').slice(0, 10);
    if (when && when <= isoDate) break;   // this change was already in force
    text = h.prior_text;                  // rewind past it
  }
  return text;
}

module.exports = {
  proposedTextFor, comparativePrint, codeImpact, amendmentImpact, codify, asOf,
};
