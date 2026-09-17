import {
  ROOT_ELEMENT,
  element,
  newId,
  serialize,
  text,
  type AknElement,
  type DocType,
} from '@blevins/akn';

import { GOVERNORS, ORG, STAFF } from './org.ts';

// The catalog is the one in legacy/src/doc-templates.js — draftingDefaults()
// and amendatoryForm(). This file turns those same forms into the AKN package
// the web editor can open. It does not invent a second set of instruments.

export interface TemplateDocument {
  readonly docType: DocType;
  readonly title: string;
  readonly xml: string;
}

export interface Template {
  readonly id: string;
  readonly name: string;
  readonly path: readonly string[];
  readonly documents: readonly TemplateDocument[];
}

function guidance(body: string): AknElement {
  return element('guidance', { id: newId(), children: [text(body)] });
}

function heading(body: string): AknElement {
  return element('heading', { id: newId(), children: [text(body)] });
}

function para(body: string): AknElement {
  return element('aknP', { id: newId(), children: [text(body)] });
}

function num(body: string): AknElement {
  return element('num', { id: newId(), children: [text(body)] });
}

function unfilledSection(sectionNum: string, title: string, help: string): AknElement {
  return element('tblock', {
    id: newId(),
    children: [num(sectionNum), heading(title), para('Not Applicable'), guidance(help)],
  });
}

function masthead(): AknElement {
  const column = (name: string, people: readonly { name: string; title: string }[]) =>
    element('container', {
      attrs: { name },
      id: newId(),
      children: people.flatMap((p) => [
        element('docProponent', { id: newId(), children: [text(p.name)] }),
        element('docTitle', { id: newId(), children: [text(p.title)] }),
      ]),
    });

  return element('container', {
    attrs: { name: 'masthead' },
    id: newId(),
    children: [
      column('governors', GOVERNORS),
      element('container', {
        attrs: { name: 'mark', 'aria-label': `${ORG.name} ${ORG.body}` },
        id: newId(),
      }),
      column('officers', STAFF),
    ],
  });
}

function build(docType: DocType, children: readonly AknElement[]): string {
  return serialize({
    docType,
    root: element(ROOT_ELEMENT[docType], {
      attrs: { name: docType },
      id: newId(),
      children,
    }),
  });
}

function coverPage(kind: string): TemplateDocument {
  return {
    docType: 'COVER_PAGE',
    title: 'Cover Page',
    xml: build('COVER_PAGE', [
      masthead(),
      element('coverPage', {
        id: newId(),
        children: [
          element('longTitle', {
            id: newId(),
            children: [
              element('docStage', { id: newId(), children: [text('Proposed')] }),
              element('docType', { id: newId(), children: [text(kind)] }),
              element('docPurpose', { id: newId(), children: [text('[Short title]')] }),
            ],
          }),
        ],
      }),
    ]),
  };
}

function boardLetter(): TemplateDocument {
  return {
    docType: 'EXPL_MEMORANDUM',
    title: 'Board Letter',
    xml: build('EXPL_MEMORANDUM', [
      masthead(),
      element('preface', {
        id: newId(),
        children: [element('longTitle', { id: newId(), children: [heading('BOARD LETTER')] })],
      }),
      element('mainBody', {
        id: newId(),
        children: [
          unfilledSection(
            '1.',
            'OVERVIEW',
            'State plainly what the Board is being asked to do and why it is before them now.',
          ),
          unfilledSection(
            '2.',
            'RECOMMENDATION',
            'The specific action recommended, in the words the motion would use.',
          ),
          unfilledSection(
            '3.',
            'FISCAL IMPACT',
            'Cost, funding source, and any ongoing obligation. If there is none, say so — silence reads as an oversight.',
          ),
          unfilledSection(
            '4.',
            'BACKGROUND',
            'Prior Board action, the governing authority, and how the matter arrived here.',
          ),
          unfilledSection(
            '5.',
            'ADVISORY BODY STATEMENT',
            'Any committee or advisory body that has considered this, and what it concluded.',
          ),
        ],
      }),
    ]),
  };
}

function fiscalStatement(): TemplateDocument {
  return {
    docType: 'FINANCIAL_STATEMENT',
    title: 'Fiscal Impact Statement',
    xml: build('FINANCIAL_STATEMENT', [
      element('preface', {
        id: newId(),
        children: [
          element('longTitle', { id: newId(), children: [heading('FISCAL IMPACT STATEMENT')] }),
        ],
      }),
      element('mainBody', {
        id: newId(),
        children: [
          unfilledSection('1.', 'CURRENT YEAR COST', 'Direct cost in the current fiscal year.'),
          unfilledSection('2.', 'ONGOING COST', 'Recurring annual cost, and for how long.'),
          unfilledSection('3.', 'FUNDING SOURCE', 'Which fund or appropriation bears it.'),
          unfilledSection(
            '4.',
            'STAFFING IMPACT',
            'Positions added, removed, or reclassified. State none if none.',
          ),
        ],
      }),
    ]),
  };
}

/** Same strings as draftingDefaults() / amendatoryForm() in doc-templates.js. */
function draftingForms(): Record<string, string> {
  const org = ORG.name;
  return {
    Action: `WHEREAS, ____; and
WHEREAS, ____; and
NOW, THEREFORE, BE IT RESOLVED by the ${org}:

SECTION 1. ____.
(a) ____
(b) ____

SECTION 2. Direction to staff.
The ____ is directed to ____ and to report to the ${org} on ____.

SECTION 3. Effective date.
This takes effect immediately upon adoption.`,
    Information: `SECTION 1. Purpose.
This item is submitted to the ${org} for information. No action is requested.

SECTION 2. Background.
____

SECTION 3. Discussion.
____`,
    Ordinance: `SECTION 1. Short title.
This ordinance may be cited as the "{{title}}".

SECTION 2. Findings.
The ${org} finds that—
(a) ____; and
(b) ____.

SECTION 3. Definitions.
In this ordinance—
(a) "____" means ____.
(b) "____" means ____.

SECTION 4. ____.
(a) In general. ____
(b) Administration. The ____ shall—
(1) ____; and
(2) ____.
(c) Reporting. Not later than ____ of each year, the ____ shall report to the ${org} on ____.

SECTION 5. Severability.
If any provision of this ordinance, or its application to any person or circumstance, is held invalid, the remainder of this ordinance and its application to other persons or circumstances are not affected.

SECTION 6. Effective date.
This ordinance takes effect thirty (30) days after adoption.`,
    Resolution: `WHEREAS, ____; and
WHEREAS, ____; and
NOW, THEREFORE, BE IT RESOLVED by the ${org}:

SECTION 1. ____.
(a) ____
(b) ____

SECTION 2. Direction to staff.
The ____ is directed to ____ and to report to the ${org} on ____.

SECTION 3. Effective date.
This resolution takes effect immediately upon adoption.`,
    Motion: `SECTION 1. Motion.
I move that the ${org} ____.`,
    Contract: `SECTION 1. Authorization.
The ${org} authorizes the ____ to execute an agreement with ____ for ____.

SECTION 2. Terms.
(a) Scope. The agreement shall provide for ____.
(b) Compensation. Compensation under the agreement may not exceed $____ over the term.
(c) Term. The agreement commences ____ and ends ____, with ____ option(s) to renew.

SECTION 3. Conditions.
(a) The agreement is subject to approval as to form.
(b) No payment may be made except from funds appropriated for that purpose.

SECTION 4. Effective date.
This authorization takes effect immediately upon adoption.`,
    Appointment: `SECTION 1. Appointment.
The ${org} appoints ____ to the ____.

SECTION 2. Term.
The term begins ____ and ends ____.

SECTION 3. Effective date.
This appointment takes effect immediately upon adoption.`,
    'Public Hearing': `SECTION 1. Notice.
NOTICE IS HEREBY GIVEN that the ${org} will hold a public hearing on {{date}} at ____ concerning ____.

SECTION 2. Subject.
The hearing concerns ____.

SECTION 3. Participation.
(a) Written comment may be submitted to the Clerk of the Board until ____.
(b) Persons wishing to be heard may register with the clerk before the hearing.`,
    Proclamation: `WHEREAS, ____; and
WHEREAS, ____;
NOW, THEREFORE, the ${org} proclaims:

SECTION 1. Proclamation.
____ is hereby recognized as ____.`,
    Report: `SECTION 1. Purpose.
____

SECTION 2. Findings.
(a) ____
(b) ____

SECTION 3. Recommendation.
The ____ recommends that the ${org} ____.`,
    Communication: `SECTION 1. Subject.
____`,
    Amendatory: `SECTION 1. Short title.
This ordinance may be cited as the "{{title}}".

SECTION 2. Amendment of section ____ of the ${org} Code.
Section ____ of the ${org} Code is amended to read as follows:
(a) ____
(b) ____

SECTION 3. Conforming amendments.
Section ____ of the ${org} Code is amended by striking "____" and inserting "____".

SECTION 4. Effective date.
This ordinance takes effect ____.`,
  };
}

function fillPlaceholders(tpl: string): string {
  return tpl
    .replace(/\{\{\s*title\s*\}\}/g, '____')
    .replace(/\{\{\s*date\s*\}\}/g, '____')
    .replace(/\{\{\s*file_number\s*\}\}/g, '____')
    .replace(/\{\{\s*org\s*\}\}/g, ORG.name);
}

function actFromForm(kind: string, formName: string, headingText: string): TemplateDocument {
  const raw = draftingForms()[formName];
  if (!raw) throw new Error(`No drafting form ${formName}`);
  const form = fillPlaceholders(raw);
  const chunks = form.split(/\n(?=SECTION\s+)/);
  const preamble: string[] = [];
  const articles: AknElement[] = [];

  for (const chunk of chunks) {
    const match = chunk.match(/^SECTION\s+([^.\n]+)\.\s*([^\n]*)\n?([\s\S]*)$/);
    if (!match) {
      preamble.push(...chunk.split('\n').map((l) => l.trim()).filter(Boolean));
      continue;
    }
    const sectionNum = `SECTION ${match[1]!.trim()}.`;
    const title = (match[2] ?? '').trim().replace(/\.$/, '') || 'Section';
    const body = (match[3] ?? '').trim() || '____';
    articles.push(
      element('article', {
        id: newId(),
        children: [
          num(sectionNum),
          heading(title),
          element('paragraph', {
            id: newId(),
            children: [
              element('content', {
                id: newId(),
                children: body.split(/\n+/).filter(Boolean).map(para),
              }),
            ],
          }),
        ],
      }),
    );
  }

  const recitals = preamble.filter((l) => /^WHEREAS\b/i.test(l));
  const formulaLine = preamble.find((l) => /THEREFORE|ordains|proclaims/i.test(l));

  const children: AknElement[] = [
    element('preface', {
      id: newId(),
      children: [
        element('longTitle', {
          id: newId(),
          children: [
            element('docType', { id: newId(), children: [text(headingText)] }),
            element('docPurpose', { id: newId(), children: [text('[Short title]')] }),
          ],
        }),
      ],
    }),
  ];

  if (recitals.length || formulaLine) {
    children.push(
      element('preamble', {
        id: newId(),
        children: [
          ...(recitals.length
            ? [
                element('recitals', {
                  id: newId(),
                  children: recitals.map((line, i) =>
                    element('recital', {
                      id: newId(),
                      children: [num(`(${i + 1})`), para(line)],
                    }),
                  ),
                }),
              ]
            : []),
          ...(formulaLine
            ? [
                element('formula', {
                  attrs: { name: 'enactingFormula' },
                  id: newId(),
                  children: [para(formulaLine)],
                }),
              ]
            : []),
        ],
      }),
    );
  }

  children.push(element('aknBody', { id: newId(), children: articles }));

  return { docType: 'LEGAL_ACT', title: kind, xml: build('LEGAL_ACT', children) };
}

function memoFromForm(title: string, formName: string): TemplateDocument {
  const raw = draftingForms()[formName];
  if (!raw) throw new Error(`No drafting form ${formName}`);
  const form = fillPlaceholders(raw);
  const chunks = form.split(/\n(?=SECTION\s+)/);
  const blocks: AknElement[] = [];
  let n = 1;
  for (const chunk of chunks) {
    const match = chunk.match(/^SECTION\s+([^.\n]+)\.\s*([^\n]*)\n?([\s\S]*)$/);
    if (!match) continue;
    const titleLine = (match[2] ?? '').trim().replace(/\.$/, '') || 'Section';
    const body = (match[3] ?? '').trim() || 'Not Applicable';
    blocks.push(
      element('tblock', {
        id: newId(),
        children: [
          num(`${n}.`),
          heading(titleLine.toUpperCase()),
          para(body),
          guidance('Replace the blanks. An empty section is indistinguishable from one nobody reached.'),
        ],
      }),
    );
    n += 1;
  }
  return {
    docType: 'EXPL_MEMORANDUM',
    title,
    xml: build('EXPL_MEMORANDUM', [
      masthead(),
      element('preface', {
        id: newId(),
        children: [element('longTitle', { id: newId(), children: [heading(title.toUpperCase())] })],
      }),
      element('mainBody', { id: newId(), children: blocks }),
    ]),
  };
}

export const TEMPLATES: readonly Template[] = [
  {
    id: 'ORD-STD',
    name: 'Ordinance',
    path: ['Legislative instruments', 'Ordinances'],
    documents: [
      coverPage('ORDINANCE'),
      boardLetter(),
      actFromForm('Ordinance', 'Ordinance', 'ORDINANCE NO. __________'),
      fiscalStatement(),
    ],
  },
  {
    id: 'ORD-CODE',
    name: 'Ordinance amending the Administrative Code',
    path: ['Legislative instruments', 'Ordinances'],
    documents: [
      coverPage('ORDINANCE'),
      boardLetter(),
      actFromForm('Ordinance', 'Amendatory', 'ORDINANCE NO. __________'),
      fiscalStatement(),
    ],
  },
  {
    id: 'RES-STD',
    name: 'Resolution',
    path: ['Legislative instruments', 'Resolutions'],
    documents: [
      coverPage('RESOLUTION'),
      boardLetter(),
      actFromForm('Resolution', 'Resolution', 'RESOLUTION NO. __________'),
    ],
  },
  {
    id: 'ACT-ACTION',
    name: 'Action',
    path: ['Board actions'],
    documents: [coverPage('ACTION'), boardLetter(), actFromForm('Action', 'Action', 'FILE NO. __________')],
  },
  {
    id: 'ACT-INFO',
    name: 'Information',
    path: ['Board actions'],
    documents: [coverPage('INFORMATION'), memoFromForm('Information', 'Information')],
  },
  {
    id: 'ACT-MOTION',
    name: 'Motion',
    path: ['Board actions'],
    documents: [coverPage('MOTION'), actFromForm('Motion', 'Motion', 'MOTION')],
  },
  {
    id: 'ACT-CONTRACT',
    name: 'Contract',
    path: ['Board actions'],
    documents: [
      coverPage('CONTRACT AUTHORIZATION'),
      boardLetter(),
      actFromForm('Contract', 'Contract', 'CONTRACT AUTHORIZATION'),
      fiscalStatement(),
    ],
  },
  {
    id: 'ACT-APPT',
    name: 'Appointment',
    path: ['Board actions'],
    documents: [
      coverPage('APPOINTMENT'),
      boardLetter(),
      actFromForm('Appointment', 'Appointment', 'APPOINTMENT'),
    ],
  },
  {
    id: 'ACT-HEAR',
    name: 'Public Hearing',
    path: ['Board actions'],
    documents: [
      coverPage('PUBLIC HEARING'),
      boardLetter(),
      actFromForm('Public Hearing', 'Public Hearing', 'NOTICE OF PUBLIC HEARING'),
    ],
  },
  {
    id: 'ACT-PROC',
    name: 'Proclamation',
    path: ['Board actions'],
    documents: [coverPage('PROCLAMATION'), actFromForm('Proclamation', 'Proclamation', 'PROCLAMATION')],
  },
  {
    id: 'ACT-REPORT',
    name: 'Report',
    path: ['Board actions'],
    documents: [coverPage('REPORT'), memoFromForm('Report', 'Report')],
  },
  {
    id: 'ACT-COMM',
    name: 'Communication',
    path: ['Board actions'],
    documents: [coverPage('COMMUNICATION'), memoFromForm('Communication', 'Communication')],
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
