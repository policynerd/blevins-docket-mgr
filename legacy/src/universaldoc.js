'use strict';

// A file, serialized to the Universal Document schema.
//
// https://blevins.co/schemas/universal-document.schema.json
//
// This is an *output* format and deliberately nothing more. The schema calls
// itself a model "for CMS rendering and API integrations", which is a
// serialization concern, and it can be satisfied entirely from what this
// application already stores — the letter's named sections, the provision tree
// legisdoc already parses, the attachments, the sponsors, the route and the
// signatures. Nothing here changes how a record is kept, and nothing here goes
// near the vote ledger. Restructuring storage to match a format that has no
// consumer yet would put the record at risk to no purpose; if this proves out
// against something real, storage can follow it rather than lead it.
//
// Three of the schema's ideas do not map cleanly onto this application, and
// each is resolved here in the direction that says less rather than more.

const { ORG } = require('./org');
const repo = require('./repo');
const legisdoc = require('./legisdoc');
const documents = require('./documents');

/**
 * The schema's status is a document lifecycle; ours is a legislative process.
 *
 * DRAFT → ACTIVE → SUPERSEDED → ARCHIVED describes what is true of a document.
 * Draft → Introduced → In Committee → On Agenda → Passed → Enacted describes
 * where a measure has got to. They are different axes, not two vocabularies
 * for one: a measure can be Enacted and also Superseded, and collapsing them
 * loses which was meant.
 *
 * So the lifecycle value is mapped conservatively, and the process status is
 * carried beside it under `processStatus`. The schema does not close `meta` to
 * additional properties, so a document carrying both still validates — and a
 * consumer that wants the real answer can have it rather than a lossy
 * translation.
 *
 * SUPERSEDED and EXPIRED are never emitted: this application has no notion of
 * either, and a status invented at the serializer would be a claim nobody
 * made.
 */
const LIFECYCLE = {
  Draft: 'DRAFT',
  Introduced: 'UNDER_REVIEW',
  'In Committee': 'UNDER_REVIEW',
  'On Agenda': 'UNDER_REVIEW',
  Passed: 'APPROVED',
  Enacted: 'ACTIVE',
  Failed: 'ARCHIVED',
  Vetoed: 'ARCHIVED',
  Withdrawn: 'ARCHIVED',
};

/**
 * The schema offers five classifications; this application has two states.
 *
 * PUBLIC / INTERNAL / CONFIDENTIAL / RESTRICTED / BOARD_ONLY, against a single
 * `published_at` that is either set or not, with the line drawn at member.
 * Emitting a middle value would assert a distinction nothing in the system
 * enforces — a document labelled CONFIDENTIAL that any member can open is
 * worse than one labelled INTERNAL, because the label would be doing the
 * reassuring and the code would not be doing the work.
 *
 * Two of five, then, until there is a reason for more. Adding levels later is
 * cheap: the whole rule is four predicates in visibility.js.
 */
function classificationOf(matter) {
  return matter.published_at ? 'PUBLIC' : 'INTERNAL';
}

// Sanitized letter HTML into the schema's plain paragraph strings. documents
// .paragraphs is the same conversion the PDFs use, so a section cannot read
// one way in the packet and another over the API.
function textOf(html) {
  return documents.paragraphs(html);
}

// A bullet in the source becomes a bulletPoint, not a paragraph that happens
// to start with a dot.
function splitBullets(lines) {
  const paragraphs = [];
  const bulletPoints = [];
  for (const line of lines) {
    const m = /^[•–—-]\s+(.*)$/.exec(line);
    if (m) bulletPoints.push(m[1]);
    else paragraphs.push(line);
  }
  return { paragraphs, bulletPoints };
}

// legisdoc's provision tree is already the shape contentSection describes:
// an identified node with a heading, text, and children. Carried across
// rather than re-derived, so the API and the drafting screen cannot disagree
// about the structure of an ordinance.
function provisionSection(node) {
  const out = { sectionId: node.id || node.marker || '' };
  if (node.heading) out.heading = node.heading;
  if (node.text) out.paragraphs = [node.text];
  if (node.children && node.children.length) {
    out.subsections = node.children.map(provisionSection);
  }
  return out;
}

function bodySections(matter) {
  const sections = [];

  // The letter's named sections, in their configured order, and only the ones
  // somebody answered. An empty heading asserts a question was answered.
  for (const sec of repo.letters.compose(matter.id)) {
    if (!sec.filled) continue;
    const { paragraphs, bulletPoints } = splitBullets(textOf(sec.body_html));
    const out = { sectionId: sec.key, heading: sec.label };
    if (paragraphs.length) out.paragraphs = paragraphs;
    if (bulletPoints.length) out.bulletPoints = bulletPoints;
    sections.push(out);
  }

  // The measure's own text, as the provision tree legisdoc already parses.
  //
  // parse() returns { preamble, sections } — an object, not an array. Reading
  // a `.length` off it is always undefined, which silently took the fallback
  // branch and flattened every ordinance to one long string.
  const full = matter.full_text || '';
  if (full.trim()) {
    const parsed = legisdoc.parse(full);
    const text = { sectionId: 'text', heading: 'Text of the measure' };
    if (parsed.sections && parsed.sections.length) {
      text.subsections = parsed.sections.map(provisionSection);
    } else {
      // Nothing the parser recognised as a provision: carry the text whole
      // rather than assert a structure it does not have.
      text.paragraphs = full.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    }
    sections.push(text);
  }

  return sections;
}

/**
 * Who is on the document, without merging what the application keeps apart.
 *
 * `workflow_steps` records who reviewed a file; `consent_signers` records who
 * executed an instrument. Approving a routing step is not signing, and the
 * schema's single array with one status enum would flatten that back out. Both
 * are emitted, each keeping its own role name, so a reader can tell a reviewer
 * from a signatory without being told they are the same kind of thing.
 */
function parties(matter) {
  const out = [];

  for (const s of repo.matters.sponsors(matter.id)) {
    out.push({ name: s.full_name, role: s.sponsor_type || 'Sponsor', entity: ORG.name });
  }

  for (const step of repo.workflow.forMatter(matter.id)) {
    const status = step.status === 'Approved' ? 'APPROVED'
      : (step.status === 'Returned' || step.status === 'Rejected' ? 'REJECTED' : 'PENDING');
    out.push({
      name: step.acted_by_name || step.assignee_name || 'Unassigned',
      role: `Review — ${step.name}`,
      entity: ORG.name,
      status,
      signedAt: step.acted_at || null,
    });
  }

  for (const consent of repo.consents.forMatter ? repo.consents.forMatter(matter.id) : []) {
    for (const signer of repo.consents.signers(consent.id)) {
      out.push({
        name: signer.name || signer.full_name || '',
        role: 'Signatory — written consent',
        entity: ORG.name,
        status: signer.status === 'Signed' ? 'SIGNED'
          : (signer.status === 'Declined' ? 'REJECTED' : 'PENDING'),
        signedAt: signer.signed_at || null,
      });
    }
  }

  return out;
}

function attachmentsOf(matter) {
  return repo.matters.attachments(matter.id).map((a, i) => {
    const out = {
      attachmentId: `EXHIBIT-${documents.attachmentLabel(i)}`,
      title: a.name || 'Attachment',
      type: 'FILE_LINK',
    };
    // Only an absolute URL satisfies the schema's `format: uri`; an uploaded
    // file's path is meaningless outside this application, so it is named and
    // not linked rather than linked to somewhere that does not resolve.
    if (a.url && /^https?:\/\//i.test(a.url)) out.fileUrl = a.url;
    return out;
  });
}

/**
 * One file as a Universal Document.
 *
 * Takes the viewer, because the same file is a different document depending on
 * who asked: a reader who may not see it gets nothing at all rather than a
 * husk with the body removed, which would confirm the file exists and describe
 * its shape.
 */
function forMatter(matter) {
  if (!matter) return null;
  const body = matter.body_id ? repo.bodies.get(matter.body_id) : null;
  const bodyName = (body && body.name) || ORG.primaryBody || '';
  const topics = repo.topics.forMatter(matter.id).map((t) => t.name);

  const meta = {
    documentId: matter.file_number,
    title: matter.title,
    status: LIFECYCLE[matter.status] || 'DRAFT',
    securityClassification: classificationOf(matter),
    // Beside the lifecycle, never instead of it. See LIFECYCLE above.
    processStatus: matter.status || null,
  };
  if (matter.intro_date) meta.effectiveDate = matter.intro_date;
  if (matter.final_date) meta.expirationDate = null;
  if (topics.length) meta.tags = topics;

  const header = {
    organization: ORG.name,
    documentType: matter.type,
  };
  if (bodyName && bodyName.toLowerCase() !== String(ORG.name).toLowerCase()) {
    header.departmentOrBody = bodyName;
  }
  if (matter.summary) header.caption = matter.summary;

  // Anything before the first recognised provision. The schema's preamble is
  // for WHEREAS clauses and introductory matter, which is precisely what
  // legisdoc collects there, so it is carried across rather than dropped.
  const lead = matter.full_text ? legisdoc.parse(matter.full_text).preamble : [];
  const docBody = { sections: bodySections(matter) };
  if (lead.length) docBody.preamble = lead.map((text) => ({ prefix: 'WHEREAS', text }));

  const doc = { meta, header, body: docBody };

  const people = parties(matter);
  if (people.length) doc.partiesOrSignatories = people;

  const files = attachmentsOf(matter);
  if (files.length) doc.attachments = files;

  return doc;
}

module.exports = { forMatter, LIFECYCLE, classificationOf };
