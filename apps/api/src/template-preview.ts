import { findTemplate } from './templates.ts';
import { DETAILED_FORMS } from './forms.ts';

export const BOARD_LETTER_OUTLINE = [
  {
    num: '1.',
    title: 'OVERVIEW',
    help: 'State plainly what the Board is being asked to do and why it is before them now.',
  },
  {
    num: '2.',
    title: 'RECOMMENDATION',
    help: 'The specific action recommended, in the words the motion would use.',
  },
  {
    num: '3.',
    title: 'FISCAL IMPACT',
    help: 'Cost, funding source, and any ongoing obligation. If there is none, say so.',
  },
  {
    num: '4.',
    title: 'BACKGROUND',
    help: 'Prior Board action, the governing authority, and how the matter arrived here.',
  },
  {
    num: '5.',
    title: 'ADVISORY BODY STATEMENT',
    help: 'Any committee that has considered this, and what it concluded.',
  },
  {
    num: '6.',
    title: 'ALTERNATIVES CONSIDERED',
    help: 'What else was on the table and why it was not recommended.',
  },
  {
    num: '7.',
    title: 'NEXT STEPS',
    help: 'Who acts after adoption, and by when.',
  },
] as const;

export const FISCAL_OUTLINE = [
  { num: '1.', title: 'CURRENT YEAR COST', help: 'Direct cost in the current fiscal year, by fund.' },
  { num: '2.', title: 'ONGOING COST', help: 'Recurring annual cost, and for how many years.' },
  { num: '3.', title: 'FUNDING SOURCE', help: 'Which appropriation or fund bears it. Name the line.' },
  { num: '4.', title: 'STAFFING IMPACT', help: 'Positions added, removed, or reclassified.' },
  { num: '5.', title: 'OFFSETS AND REVENUE', help: 'Fees, recoveries, or reductions that net against the cost.' },
  { num: '6.', title: 'BUDGET ADJUSTMENT', help: 'Whether an appropriation adjustment is required, and in what amount.' },
] as const;

const FORMS_FOR: Record<string, string[]> = {
  'ORD-STD': ['Ordinance'],
  'ORD-CODE': ['Amendatory'],
  'RES-STD': ['Resolution'],
  'ACT-ACTION': ['Action'],
  'ACT-INFO': ['Information'],
  'ACT-MOTION': ['Motion'],
  'ACT-CONTRACT': ['Contract'],
  'ACT-APPT': ['Appointment'],
  'ACT-HEAR': ['Public Hearing'],
  'ACT-PROC': ['Proclamation'],
  'ACT-REPORT': ['Report'],
  'ACT-COMM': ['Communication'],
};

export function templatePreview(id: string) {
  const template = findTemplate(id);
  if (!template) return undefined;
  const names = FORMS_FOR[id] ?? [];
  const hasLetter = template.documents.some((d) => d.title === 'Board Letter');
  const hasFiscal = template.documents.some((d) => d.docType === 'FINANCIAL_STATEMENT');
  return {
    id: template.id,
    name: template.name,
    path: template.path,
    documents: template.documents.map((d) => ({ docType: d.docType, title: d.title })),
    forms: names.map((name) => ({ name, text: DETAILED_FORMS[name] ?? '' })),
    boardLetter: hasLetter ? BOARD_LETTER_OUTLINE.map((s) => ({ ...s })) : null,
    fiscal: hasFiscal ? FISCAL_OUTLINE.map((s) => ({ ...s })) : null,
  };
}
