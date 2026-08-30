'use strict';

// A file, serialized to the Universal Document schema.
//
// The schema is an output format: nothing here changes how a record is kept.
// So what these tests hold in place is the contract — that every required
// field is present, that every enum value emitted is one the schema allows,
// and that the three places where the schema and this application disagree are
// resolved in the direction that says less rather than more.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

process.env.DOCKET_DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ud-test-')), 'test.db');

const { init } = require('../src/db');
init();
const repo = require('../src/repo');
const ud = require('../src/universaldoc');
const api = require('../src/api');

// The enums the schema declares. Kept here as literals rather than read from
// the schema file: a serializer that learned its allowed values from the same
// place it wrote them would agree with itself and prove nothing.
const STATUS = ['DRAFT', 'UNDER_REVIEW', 'APPROVED', 'ACTIVE', 'EXPIRED', 'SUPERSEDED', 'ARCHIVED'];
const CLASSIFICATION = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED', 'BOARD_ONLY'];
const PARTY_STATUS = ['PENDING', 'SIGNED', 'APPROVED', 'REJECTED'];

const bodyId = repo.bodies.insert({ name: 'Board of Governors', type: 'Governing Body', seats: 3 });

function newMatter(over = {}) {
  const { id } = repo.matters.insertNumbered(Object.assign({
    type: 'Resolution', body_id: bodyId, status: 'Draft', title: 'A measure',
  }, over));
  return repo.matters.get(id);
}

// Walk every contentSection, however deep, and assert the one thing the schema
// requires of all of them.
function eachSection(sections, fn) {
  for (const s of sections || []) {
    fn(s);
    eachSection(s.subsections, fn);
  }
}

test('a document carries every field the schema requires', () => {
  const doc = ud.forMatter(newMatter());
  for (const k of ['meta', 'header', 'body']) assert.ok(doc[k], `missing ${k}`);
  for (const k of ['documentId', 'title', 'status', 'securityClassification']) {
    assert.ok(doc.meta[k] != null, `meta.${k} is required`);
  }
  for (const k of ['organization', 'documentType']) {
    assert.ok(doc.header[k], `header.${k} is required`);
  }
  assert.ok(Array.isArray(doc.body.sections), 'body.sections is required');
});

test('every enum value emitted is one the schema allows', () => {
  for (const status of ['Draft', 'Introduced', 'In Committee', 'On Agenda',
    'Passed', 'Enacted', 'Failed', 'Withdrawn']) {
    const doc = ud.forMatter(newMatter({ status }));
    assert.ok(STATUS.includes(doc.meta.status), `${status} produced ${doc.meta.status}`);
    assert.ok(CLASSIFICATION.includes(doc.meta.securityClassification));
  }
});

test('an unknown status degrades to DRAFT rather than inventing a value', () => {
  const doc = ud.forMatter(newMatter({ status: 'Something Nobody Configured' }));
  assert.equal(doc.meta.status, 'DRAFT');
});

test('the process status is carried beside the lifecycle, not instead of it', () => {
  // They are different axes. A measure can be Enacted (process) and one day
  // Superseded (document); collapsing them loses which was meant.
  const doc = ud.forMatter(newMatter({ status: 'On Agenda' }));
  assert.equal(doc.meta.status, 'UNDER_REVIEW');
  assert.equal(doc.meta.processStatus, 'On Agenda');
});

test('SUPERSEDED and EXPIRED are never emitted', () => {
  // This application has no notion of either, and a status invented at the
  // serializer would be a claim nobody made.
  for (const status of ['Draft', 'Introduced', 'Passed', 'Enacted', 'Failed']) {
    const doc = ud.forMatter(newMatter({ status }));
    assert.notEqual(doc.meta.status, 'SUPERSEDED');
    assert.notEqual(doc.meta.status, 'EXPIRED');
  }
});

test('classification follows publication, and claims nothing more', () => {
  const m = newMatter();
  assert.equal(ud.classificationOf(m), 'INTERNAL');
  repo.matters.publish(m.id);
  assert.equal(ud.classificationOf(repo.matters.get(m.id)), 'PUBLIC');
  // Only the two states the code actually enforces. A middle value would
  // assert a distinction nothing in the system upholds.
  assert.equal(ud.classificationOf({ published_at: null }), 'INTERNAL');
});

test('letter sections become sections, and bullets become bulletPoints', () => {
  const m = newMatter();
  repo.letters.save(m.id, 'recommendation',
    '<p>It is recommended that the Board:<ul><li>Approve it.</li><li>Authorize it.</li></ul>');
  const doc = ud.forMatter(repo.matters.get(m.id));
  const sec = doc.body.sections.find((s) => s.sectionId === 'recommendation');
  assert.ok(sec, 'the written section should be emitted');
  assert.deepEqual(sec.paragraphs, ['It is recommended that the Board:']);
  assert.deepEqual(sec.bulletPoints, ['Approve it.', 'Authorize it.']);
});

test('an unwritten section is omitted, not emitted empty', () => {
  // An empty heading asserts a question was answered.
  const doc = ud.forMatter(newMatter());
  assert.equal(doc.body.sections.length, 0);
});

test('a measure carries its provision tree, nested, not flattened', () => {
  // legisdoc.parse returns { preamble, sections } — an object. Reading a
  // `.length` off it is always undefined, which silently flattened every
  // ordinance into one long paragraph while still producing a valid-looking
  // document. The assertion is on the nesting, so that cannot pass again.
  const m = newMatter({ type: 'Ordinance' });
  repo.letters.save(m.id, 'background', '<p>Background.</p>');
  repo.matters.update(m.id, Object.assign({}, repo.matters.get(m.id), {
    full_text: [
      'The Board finds that revision is required.',
      'Section 1. Definitions.',
      '(a) A subsection.',
      '(1) A clause beneath it.',
      'Section 2. Effective date.',
    ].join('\n'),
  }));
  const doc = ud.forMatter(repo.matters.get(m.id));

  const text = doc.body.sections.find((s) => s.sectionId === 'text');
  assert.ok(text, 'the measure text should be a section');
  assert.ok(text.subsections && text.subsections.length === 2, 'two numbered sections');
  assert.equal(text.subsections[0].heading, 'Definitions.');
  const sub = text.subsections[0].subsections;
  assert.ok(sub && sub.length === 1, 'the subsection hangs under its section');
  assert.ok(sub[0].subsections && sub[0].subsections.length === 1, 'and the clause under that');
  assert.equal(text.paragraphs, undefined, 'a parsed measure is not also flattened');

  // Matter before the first provision becomes the schema's preamble.
  assert.ok(doc.body.preamble && doc.body.preamble.length === 1);
  assert.equal(doc.body.preamble[0].prefix, 'WHEREAS');

  let count = 0;
  eachSection(doc.body.sections, (s) => {
    count += 1;
    assert.ok(s.sectionId != null && s.sectionId !== '', 'sectionId is required');
  });
  assert.ok(count >= 6, 'letter section, text, two sections, a subsection, a clause');
});

test('text the parser recognises no provisions in is carried whole', () => {
  const m = newMatter();
  repo.matters.update(m.id, Object.assign({}, repo.matters.get(m.id), {
    full_text: 'One plain paragraph.\n\nAnd a second.',
  }));
  const doc = ud.forMatter(repo.matters.get(m.id));
  const text = doc.body.sections.find((s) => s.sectionId === 'text');
  assert.deepEqual(text.paragraphs, ['One plain paragraph.', 'And a second.']);
  assert.equal(text.subsections, undefined, 'no structure is asserted that is not there');
});

test('reviewers and signatories keep their own roles', () => {
  // workflow_steps records who reviewed; consent_signers records who executed.
  // Approving a routing step is not signing, and the schema's single array
  // would flatten that back out.
  const m = newMatter();
  const person = repo.people.insert({ full_name: 'A Sponsor', email: 's@t.gov' });
  repo.matters.addSponsor(m.id, person, 'Primary');
  const doc = ud.forMatter(repo.matters.get(m.id));
  const roles = (doc.partiesOrSignatories || []).map((p) => p.role);
  assert.ok(roles.includes('Primary'), 'the sponsor keeps its own role');
  for (const p of doc.partiesOrSignatories || []) {
    assert.ok(p.name, 'a party needs a name');
    assert.ok(p.role, 'a party needs a role');
    if (p.status) assert.ok(PARTY_STATUS.includes(p.status), `bad status ${p.status}`);
  }
});

test('an attachment is linked only where the link resolves off this server', () => {
  const m = newMatter();
  const { db } = require('../src/db');
  db.prepare('INSERT INTO attachments (matter_id,name,file_path) VALUES (?,?,?)')
    .run(m.id, 'Uploaded.pdf', 'somewhere.pdf');
  db.prepare('INSERT INTO attachments (matter_id,name,url) VALUES (?,?,?)')
    .run(m.id, 'Remote.pdf', 'https://example.test/a.pdf');
  const doc = ud.forMatter(repo.matters.get(m.id));
  const byTitle = Object.fromEntries(doc.attachments.map((a) => [a.title, a]));
  assert.equal(byTitle['Uploaded.pdf'].fileUrl, undefined,
    'an upload path means nothing outside this application');
  assert.equal(byTitle['Remote.pdf'].fileUrl, 'https://example.test/a.pdf');
  for (const a of doc.attachments) assert.ok(a.attachmentId && a.title);
});

test('a missing file yields nothing at all', () => {
  assert.equal(ud.forMatter(null), null);
});

// --- The resolver the API shares ---------------------------------------------

test('a file resolves by its file number, which is all digits', () => {
  // The bug this fixes: the resolver tested /^\d+$/ and took the row-id branch
  // when the key was all digits — which is every file number this application
  // issues. 260806 is a file number, not row 260806, so the documented public
  // identifier never resolved.
  const m = newMatter();
  assert.match(m.file_number, /^\d+$/, 'file numbers here are all digits');
  const found = api.resolveMatter(m.file_number);
  assert.ok(found, 'a file number should resolve');
  assert.equal(found.id, m.id);
});

test('the row id still resolves as a fallback', () => {
  const m = newMatter();
  assert.equal(api.resolveMatter(String(m.id)).id, m.id);
});

test('an unknown key resolves to nothing', () => {
  assert.equal(api.resolveMatter('no-such-file'), null);
});
