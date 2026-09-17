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

function recital(n: string, body: string, help?: string): AknElement {
  return element('recital', {
    id: newId(),
    children: [num(n), para(body), ...(help ? [guidance(help)] : [])],
  });
}

function article(n: string, title: string, body: string, help?: string): AknElement {
  return element('article', {
    id: newId(),
    children: [
      num(n),
      heading(title),
      element('paragraph', {
        id: newId(),
        children: [
          element('content', {
            id: newId(),
            children: [para(body), ...(help ? [guidance(help)] : [])],
          }),
        ],
      }),
    ],
  });
}

function unfilledSection(sectionNum: string, title: string, help: string): AknElement {
  return element('tblock', {
    id: newId(),
    children: [num(sectionNum), heading(title), para('Not Applicable'), guidance(help)],
  });
}

function filledSection(sectionNum: string, title: string, body: string, help: string): AknElement {
  return element('tblock', {
    id: newId(),
    children: [num(sectionNum), heading(title), para(body), guidance(help)],
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

function conclusions(kind: 'ordinance' | 'resolution' | 'policy'): AknElement {
  const line =
    kind === 'resolution'
      ? 'PASSED AND ADOPTED by the Board of Governors of Blevins Holdings this ____ day of ____________, 20____.'
      : kind === 'policy'
        ? 'ADOPTED by the Board of Governors of Blevins Holdings this ____ day of ____________, 20____.'
        : 'PASSED, APPROVED, AND ADOPTED by the Board of Governors of Blevins Holdings this ____ day of ____________, 20____.';
  return element('conclusions', {
    id: newId(),
    children: [
      para(line),
      element('block', {
        attrs: { name: 'signatory' },
        id: newId(),
        children: [
          element('signature', {
            id: newId(),
            children: [
              element('role', { id: newId(), children: [text('Chair, Board of Governors')] }),
              element('person', { id: newId(), children: [text('______________________________')] }),
            ],
          }),
          element('signature', {
            id: newId(),
            children: [
              element('role', { id: newId(), children: [text('Attest: Clerk of the Board')] }),
              element('person', { id: newId(), children: [text('______________________________')] }),
            ],
          }),
        ],
      }),
      guidance('Leave the blanks. The Clerk fills the date and the signatures after the vote.'),
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

function coverPage(kind: string, purpose = '[Short title]'): TemplateDocument {
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
              element('docPurpose', { id: newId(), children: [text(purpose)] }),
            ],
          }),
          guidance(
            'The short title is what is read aloud when the item is called. Keep it to one line.',
          ),
        ],
      }),
    ]),
  };
}

function boardLetter(
  extras: readonly AknElement[] = [],
  overviewHelp = 'State plainly what the Board is being asked to do and why it is before them now.',
): TemplateDocument {
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
          unfilledSection('1.', 'OVERVIEW', overviewHelp),
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
          ...extras,
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
                children: [text('An Ordinance Relating to [subject]')],
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
              recital(
                '(1)',
                'WHEREAS, the Board of Governors is authorized to adopt ordinances for the governance of Blevins Holdings; and',
                'Cite the charter, code section, or prior ordinance that gives the Board this power.',
              ),
              recital(
                '(2)',
                'WHEREAS, [the condition that makes this ordinance necessary]; and',
                'One fact per recital. Do not argue the recommendation here.',
              ),
              recital(
                '(3)',
                'WHEREAS, the Board has considered the matter and finds that the following ordinance is in the interest of the organization;',
              ),
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
          article(
            'SECTION 1.',
            'Purpose',
            'This ordinance is adopted to [state the purpose in one sentence].',
            'Purpose is not the operative rule. The rule belongs in the next sections.',
          ),
          article(
            'SECTION 2.',
            'Operative provisions',
            '[State the rule. Who must do what, by when, and under what authority.]',
            'Write the command. Definitions come first if a term will be used more than once.',
          ),
          article(
            'SECTION 3.',
            'Severability',
            'If any provision of this ordinance is held invalid, the remainder shall not be affected.',
          ),
          article(
            'SECTION 4.',
            'Effective date',
            'This ordinance shall take effect and be in force thirty (30) days after its adoption.',
          ),
        ],
      }),
      conclusions('ordinance'),
    ]),
  };
}

function codeAmendment(): TemplateDocument {
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
                children: [text('An Ordinance Amending the Administrative Code')],
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
              recital(
                '(1)',
                'WHEREAS, the Administrative Code of Blevins Holdings currently provides, in [Chapter / Section], that [current rule, in brief]; and',
              ),
              recital(
                '(2)',
                'WHEREAS, the Board finds that the Code should be amended as set forth below;',
              ),
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
          article(
            'SECTION 1.',
            'Amendment',
            'Section [X.XX] of the Administrative Code is amended to read as follows: "[Insert the section as it will read after adoption. Do not describe the change — write the new text.]".',
            'The annex holds the comparison. This section holds only the text that will be law.',
          ),
          article(
            'SECTION 2.',
            'Repeal of inconsistent provisions',
            'Any provision of the Administrative Code inconsistent with Section 1 is repealed to the extent of the inconsistency.',
          ),
          article(
            'SECTION 3.',
            'Effective date',
            'This ordinance shall take effect and be in force thirty (30) days after its adoption.',
          ),
        ],
      }),
      conclusions('ordinance'),
    ]),
  };
}

function amendmentAnnex(): TemplateDocument {
  return {
    docType: 'ANNEX',
    title: 'Redline of the amended section',
    xml: build('ANNEX', [
      element('preface', {
        id: newId(),
        children: [
          element('longTitle', {
            id: newId(),
            children: [heading('ANNEX A — SECTION AS AMENDED')],
          }),
        ],
      }),
      element('mainBody', {
        id: newId(),
        children: [
          filledSection(
            '1.',
            'CURRENT TEXT',
            '[Paste the section as it stands today.]',
            'Copy from the Code. Do not paraphrase. A paraphrase is not the current law.',
          ),
          filledSection(
            '2.',
            'PROPOSED TEXT',
            '[Paste the section as it will read after adoption.]',
            'This must match Section 1 of the ordinance word for word.',
          ),
          filledSection(
            '3.',
            'WHAT CHANGES',
            '[One sentence each: what is added, what is struck, what is moved.]',
            'The Board reads this first. Keep it short enough to say aloud.',
          ),
        ],
      }),
    ]),
  };
}

function resolution(): TemplateDocument {
  return {
    docType: 'LEGAL_ACT',
    title: 'Resolution',
    xml: build('LEGAL_ACT', [
      element('preface', {
        id: newId(),
        children: [
          element('longTitle', {
            id: newId(),
            children: [
              element('docType', {
                id: newId(),
                children: [text('RESOLUTION NO. __________')],
              }),
              element('docPurpose', {
                id: newId(),
                children: [text('A Resolution [stating the action]')],
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
              recital(
                '(1)',
                'WHEREAS, [the fact that puts this before the Board]; and',
                'Resolutions find and then resolve. Do not hide the action in a recital.',
              ),
              recital(
                '(2)',
                'WHEREAS, [the authority or prior action this rests on]; and',
              ),
              recital(
                '(3)',
                'WHEREAS, the Board finds that the action set forth below is warranted;',
              ),
            ],
          }),
          element('formula', {
            attrs: { name: 'enactingFormula' },
            id: newId(),
            children: [
              para(
                'NOW, THEREFORE, BE IT RESOLVED by the Board of Governors of Blevins Holdings:',
              ),
            ],
          }),
        ],
      }),
      element('aknBody', {
        id: newId(),
        children: [
          article(
            '1.',
            'Resolved',
            'That [the action the Board takes].',
            'This sentence is the vote. Write it as the Clerk will record it.',
          ),
          article(
            '2.',
            'Further resolved',
            'That the Clerk of the Board and Board Counsel are authorized to take the administrative steps necessary to carry this resolution into effect.',
          ),
          article(
            '3.',
            'Effective immediately',
            'That this resolution shall take effect upon its adoption.',
          ),
        ],
      }),
      conclusions('resolution'),
    ]),
  };
}

function policyInstrument(): TemplateDocument {
  return {
    docType: 'LEGAL_ACT',
    title: 'Policy',
    xml: build('LEGAL_ACT', [
      element('preface', {
        id: newId(),
        children: [
          element('longTitle', {
            id: newId(),
            children: [
              element('docType', { id: newId(), children: [text('BOARD POLICY')] }),
              element('docPurpose', {
                id: newId(),
                children: [text('[Policy title]')],
              }),
            ],
          }),
        ],
      }),
      element('aknBody', {
        id: newId(),
        children: [
          article(
            '1.',
            'Purpose',
            'This policy states [what the Board is setting as standing direction].',
          ),
          article(
            '2.',
            'Scope',
            'This policy applies to [who, which bodies, which records].',
          ),
          article(
            '3.',
            'Policy',
            '[The rule, in the present tense. Not a recommendation — a standing instruction.]',
          ),
          article(
            '4.',
            'Responsibilities',
            '[Who keeps the policy, who reports on it, and to whom.]',
          ),
          article(
            '5.',
            'Review',
            'The Clerk shall place this policy on the Board calendar for review no later than [date / interval].',
          ),
        ],
      }),
      conclusions('policy'),
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
          unfilledSection('1.', 'CURRENT YEAR COST', 'Direct cost in the current fiscal year. Use dollars, not adjectives.'),
          unfilledSection('2.', 'ONGOING COST', 'Recurring annual cost, and for how long.'),
          unfilledSection('3.', 'FUNDING SOURCE', 'Which fund or appropriation bears it. Name the account.'),
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
    documents: [
      coverPage('ORDINANCE', 'An Ordinance Amending the Administrative Code'),
      boardLetter(
        [
          unfilledSection(
            '6.',
            'CODE SECTION AFFECTED',
            'Cite the chapter and section. If more than one section moves, list each.',
          ),
        ],
        'Name the Code section and say, in one sentence, what the amendment does.',
      ),
      codeAmendment(),
      amendmentAnnex(),
      fiscalStatement(),
    ],
  },
  {
    id: 'RES-STD',
    name: 'Resolution',
    path: ['Legislative instruments', 'Resolutions'],
    documents: [
      coverPage('RESOLUTION'),
      boardLetter(
        [],
        'A resolution finds and then acts. Say the finding and the act, not a new rule of general application — that is an ordinance.',
      ),
      resolution(),
    ],
  },
  {
    id: 'POL-STD',
    name: 'Board policy',
    path: ['Legislative instruments', 'Policies'],
    documents: [
      coverPage('BOARD POLICY'),
      boardLetter(
        [
          unfilledSection(
            '6.',
            'SUNSET OR REVIEW DATE',
            'When this policy comes back. A policy with no review date is how old instructions linger.',
          ),
        ],
        'A policy is standing direction. If it is a one-time act, use a resolution.',
      ),
      policyInstrument(),
    ],
  },
  {
    id: 'ACT-APPT',
    name: 'Appointment or confirmation',
    path: ['Board actions'],
    documents: [
      coverPage('RESOLUTION', 'Appointment of [name] as [office]'),
      boardLetter(
        [
          unfilledSection(
            '6.',
            'CANDIDATE',
            'Name, current office if any, term to be filled, and who nominated.',
          ),
        ],
        'Who is being appointed, to what seat or office, and for what term.',
      ),
      resolution(),
    ],
  },
  {
    id: 'ACT-APPR',
    name: 'Appropriation',
    path: ['Board actions'],
    documents: [
      coverPage('RESOLUTION', 'Appropriation for [purpose]'),
      boardLetter(
        [
          unfilledSection(
            '6.',
            'AMOUNT AND ACCOUNT',
            'The dollar figure and the fund it is drawn from. Do not bury the number in the overview.',
          ),
        ],
        'What is being spent, from which fund, and what it buys.',
      ),
      resolution(),
      fiscalStatement(),
    ],
  },
  {
    id: 'ACT-CONSENT',
    name: 'Consent calendar item',
    path: ['Board actions'],
    documents: [
      coverPage('CONSENT ITEM'),
      boardLetter(
        [],
        'Consent is for matters that do not need discussion. If it needs a speech, it does not belong here.',
      ),
    ],
  },
];

export function findTemplate(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
