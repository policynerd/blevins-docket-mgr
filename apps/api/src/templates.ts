import {
  ROOT_ELEMENT,
  element,
  newId,
  serialize,
  text,
  type AknElement,
  type DocType,
} from '@blevins/akn';

// What a proposal is made of.
//
// A template does not describe one document. It describes the package: which
// parts exist, in what order, and what each one starts life as. Creating a
// proposal instantiates all of them at once, which is what makes the parts
// independently editable from the first moment rather than being carved out of
// a single blob later.
//
// The instruments are ours — an ordinance, a board letter, a fiscal impact
// statement. Only the structure is borrowed. EU drafting conventions
// (`Having regard to...`, numbered recitals) belong to EU institutions; a
// board ordinance that adopted them would read as a costume.

export interface TemplateDocument {
  readonly docType: DocType;
  readonly title: string;
  /** Starting content, serialized AKN. */
  readonly xml: string;
}

export interface Template {
  readonly id: string;
  readonly name: string;
  /** Where it sits in the picker's tree, e.g. ['Ordinances', 'Code amendment']. */
  readonly path: readonly string[];
  readonly documents: readonly TemplateDocument[];
}

/**
 * Drafting guidance: instructions to whoever holds the pen, carried in the
 * document itself.
 *
 * LEOS prints these inline in green next to each empty section, so a blank
 * heading explains what belongs under it instead of leaving the drafter to
 * guess. They are part of the document tree — they travel with the draft, get
 * versioned with it, and are hidden by the stylesheet on export rather than
 * stripped, so nothing has to remember to remove them before publication.
 */
function guidance(body: string): AknElement {
  return element('guidance', { id: newId(), children: [text(body)] });
}

function heading(body: string): AknElement {
  return element('heading', { id: newId(), children: [text(body)] });
}

function para(body: string): AknElement {
  return element('aknP', { id: newId(), children: [text(body)] });
}

/**
 * An unfilled section says so, out loud.
 *
 * A section that renders as nothing is indistinguishable from a section
 * nobody has reached yet. Printing `Not Applicable` makes the omission a
 * decision on the record — the same reason LEOS ships it as the default
 * content of every empty block rather than leaving them blank.
 */
function unfilledSection(num: string, title: string, help: string): AknElement {
  return element('tblock', {
    id: newId(),
    children: [
      element('num', { id: newId(), children: [text(num)] }),
      heading(title),
      para('Not Applicable'),
      guidance(help),
    ],
  });
}

/**
 * Serialize a starting document. The AKN root wrapper is chosen by document
 * type — a normative act roots at `bill`, an explanatory one at `doc` — and
 * `serialize` supplies the `akomaNtoso` envelope and namespaces itself.
 */
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

function coverPage(title: string): TemplateDocument {
  return {
    docType: 'COVER_PAGE',
    title: 'Cover Page',
    xml: build('COVER_PAGE', [
      element('coverPage', {
        id: newId(),
        children: [
          element('container', {
            attrs: { name: 'actingEntity' },
            id: newId(),
            children: [para('BLEVINS HOLDINGS — BOARD OF GOVERNORS')],
          }),
          element('longTitle', {
            id: newId(),
            children: [
              element('docStage', {
                id: newId(),
                children: [text('Proposed')],
              }),
              element('docType', { id: newId(), children: [text(title)] }),
              element('docPurpose', {
                id: newId(),
                children: [text('[Short title]')],
              }),
            ],
          }),
        ],
      }),
    ]),
  };
}

/** The board letter — our analogue of the explanatory memorandum. */
function boardLetter(): TemplateDocument {
  return {
    docType: 'EXPL_MEMORANDUM',
    title: 'Board Letter',
    xml: build('EXPL_MEMORANDUM', [
      element('preface', {
        id: newId(),
        children: [
          element('longTitle', {
            id: newId(),
            children: [heading('BOARD LETTER')],
          }),
        ],
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

function ordinance(): TemplateDocument {
  return {
    docType: 'LEGAL_ACT',
    title: 'Ordinance',
    xml: build('LEGAL_ACT', [
      element('preface', {
        id: newId(),
        children: [
          element('longTitle', {
            id: newId(),
            children: [
              element('docType', {
                id: newId(),
                children: [text('ORDINANCE NO. __________')],
              }),
              element('docPurpose', {
                id: newId(),
                children: [text('[Short title]')],
              }),
            ],
          }),
        ],
      }),
      element('preamble', {
        id: newId(),
        children: [
          element('recitals', {
            id: newId(),
            children: [
              element('recital', {
                id: newId(),
                children: [para('WHEREAS, ____; and')],
              }),
              element('recital', {
                id: newId(),
                children: [para('WHEREAS, ____;')],
              }),
            ],
          }),
          element('formula', {
            attrs: { name: 'enactingFormula' },
            id: newId(),
            children: [para('The Board of Governors of Blevins Holdings ordains as follows:')],
          }),
        ],
      }),
      element('aknBody', {
        id: newId(),
        children: [
          element('article', {
            id: newId(),
            children: [
              element('num', { id: newId(), children: [text('SECTION 1.')] }),
              heading('[Heading]'),
              element('paragraph', {
                id: newId(),
                children: [
                  element('content', {
                    id: newId(),
                    children: [para('[Text]')],
                  }),
                ],
              }),
            ],
          }),
          element('article', {
            id: newId(),
            children: [
              element('num', { id: newId(), children: [text('SECTION 2.')] }),
              heading('Effective date'),
              element('paragraph', {
                id: newId(),
                children: [
                  element('content', {
                    id: newId(),
                    children: [
                      para(
                        'This ordinance shall take effect and be in force thirty (30) days after its adoption.',
                      ),
                    ],
                  }),
                ],
              }),
            ],
          }),
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
          element('longTitle', {
            id: newId(),
            children: [heading('FISCAL IMPACT STATEMENT')],
          }),
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

export const TEMPLATES: readonly Template[] = [
  {
    id: 'ORD-STD',
    name: 'Ordinance',
    path: ['Legislative instruments', 'Ordinances'],
    documents: [coverPage('ORDINANCE'), boardLetter(), ordinance(), fiscalStatement()],
  },
  {
    id: 'ORD-CODE',
    name: 'Ordinance amending the Administrative Code',
    path: ['Legislative instruments', 'Ordinances'],
    documents: [coverPage('ORDINANCE'), boardLetter(), ordinance(), fiscalStatement()],
  },
  {
    id: 'RES-STD',
    name: 'Resolution',
    path: ['Legislative instruments', 'Resolutions'],
    documents: [coverPage('RESOLUTION'), boardLetter(), ordinance()],
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
