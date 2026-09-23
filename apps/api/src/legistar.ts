/**
 * Legislative file lifecycle, modelled on Granicus Legistar.
 *
 * A file is not a document. It is a matter that moves through bodies:
 * drafted → routed for approval → placed on an agenda → acted on in a
 * meeting → recorded in history → given a final action and (if adopted)
 * an enactment number.
 */

export const BODIES = [
  'Clerk of the Board',
  'Board of Governors',
  'Committee of the Whole',
  'Committee on Compensation & Talent',
  'Committee on Security & Classified Programs',
  'Committee on Legal & Regulatory Affairs',
  'Committee on Audit & Risk',
  'Committee on Health, Safety & Environment',
  'Committee on Investment & Endowment',
  'Committee on Philanthropy & Community',
  'Committee on Ethics & Conduct',
  'Committee on Technology & Cybersecurity',
  'Committee on Enterprise Operations',
  'Committee on Governance & Nominating',
] as const;

export type Body = (typeof BODIES)[number];

export const FILE_STATUSES = [
  'Draft',
  'Approval Review',
  'Ready for Agenda',
  'Scheduled',
  'In Committee',
  'Reported Out',
  'First Reading',
  'Public Hearing',
  'Second Reading',
  'Adopted',
  'Failed',
  'Withdrawn',
  'Held',
  'Referred',
  'Filed',
  'Abandoned',
] as const;

export type FileStatus = (typeof FILE_STATUSES)[number];

export const FINAL_STATUSES: readonly FileStatus[] = [
  'Adopted',
  'Failed',
  'Withdrawn',
  'Filed',
  'Abandoned',
];

export const ACTIONS = [
  'Created',
  'Submitted for Approval',
  'Approved for Agenda',
  'Returned to Drafter',
  'Introduced',
  'Referred',
  'Placed on Agenda',
  'Recommended for Adoption',
  'Recommended to Hold',
  'Held in Committee',
  'Reported Out',
  'Public Hearing Opened',
  'Public Hearing Closed',
  'Adopted',
  'Adopted as Amended',
  'Failed',
  'Withdrawn',
  'Continued',
  'Reconsidered',
  'Received and Filed',
  'Abandoned',
] as const;

export type FileAction = (typeof ACTIONS)[number];

export const VOTE_CHOICES = ['Aye', 'No', 'Abstain', 'Absent', 'Recused'] as const;
export type VoteChoice = (typeof VOTE_CHOICES)[number];

export const AGENDA_STATUSES = ['Draft', 'Final'] as const;
export type AgendaStatus = (typeof AGENDA_STATUSES)[number];

export interface Transition {
  status: FileStatus;
  inControl?: Body;
  final?: boolean;
}

export function applyAction(action: FileAction, sentTo?: string): Transition {
  switch (action) {
    case 'Created':
      return { status: 'Draft', inControl: 'Clerk of the Board' };
    case 'Submitted for Approval':
      return { status: 'Approval Review', inControl: 'Clerk of the Board' };
    case 'Approved for Agenda':
      return { status: 'Ready for Agenda', inControl: 'Clerk of the Board' };
    case 'Returned to Drafter':
      return { status: 'Draft', inControl: 'Clerk of the Board' };
    case 'Introduced':
      return { status: 'Scheduled', inControl: 'Board of Governors' };
    case 'Placed on Agenda':
      return { status: 'Scheduled', inControl: (sentTo as Body) || 'Board of Governors' };
    case 'Referred':
      return { status: 'Referred', inControl: (sentTo as Body) || 'Committee of the Whole' };
    case 'Recommended for Adoption':
    case 'Reported Out':
      return { status: 'Reported Out', inControl: 'Board of Governors' };
    case 'Recommended to Hold':
    case 'Held in Committee':
      return { status: 'Held', inControl: (sentTo as Body) || 'Committee of the Whole' };
    case 'Public Hearing Opened':
      return { status: 'Public Hearing', inControl: 'Board of Governors' };
    case 'Public Hearing Closed':
      return { status: 'Second Reading', inControl: 'Board of Governors' };
    case 'Adopted':
    case 'Adopted as Amended':
      return { status: 'Adopted', inControl: 'Board of Governors', final: true };
    case 'Failed':
      return { status: 'Failed', inControl: 'Board of Governors', final: true };
    case 'Withdrawn':
      return { status: 'Withdrawn', final: true };
    case 'Received and Filed':
      return { status: 'Filed', final: true };
    case 'Abandoned':
      return { status: 'Abandoned', final: true };
    case 'Continued':
      return { status: 'Scheduled' };
    case 'Reconsidered':
      return { status: 'Scheduled', inControl: 'Board of Governors' };
    default:
      return { status: 'Draft' };
  }
}

export function actionText(action: FileAction, body: string, sentTo?: string): string {
  if (action === 'Referred' && sentTo) return `Referred to the ${sentTo}.`;
  if (action === 'Placed on Agenda') return `Placed on the agenda of the ${sentTo || body}.`;
  if (action === 'Adopted') return `Adopted by the ${body}.`;
  if (action === 'Adopted as Amended') return `Adopted as amended by the ${body}.`;
  if (action === 'Failed') return `Failed before the ${body}.`;
  return `${action} — ${body}.`;
}
