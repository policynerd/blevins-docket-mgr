import { GOVERNORS, ORG } from './org.ts';

/**
 * The context a page needs in order to be read on its own.
 *
 * None of this is enacted text, so none of it belongs in the document bytes:
 * rescheduling a meeting would otherwise change the content hash of every
 * document on its agenda, and those hashes are what make the archive
 * checkable.
 */
export interface MeetingContext {
  /** "Regular Session", "Special Session". */
  session?: string;
  /** Already formatted for print — this layer does not decide date format. */
  date?: string;
  time?: string;
  /** False once the Board has adopted it. */
  draft?: boolean;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * The continuation header: governors, the mark, and which meeting this page
 * belongs to.
 *
 * A page pulled out of the middle of a packet has to say what it is. The
 * roster alone does not do that — the session and the draft marker do.
 */
export function runningHead(meeting: MeetingContext = {}): string {
  const governors = GOVERNORS.map(
    (g) => `<docProponent>${esc(g.name)}</docProponent><docTitle>${esc(g.title)}</docTitle>`,
  ).join('');

  const session = [
    meeting.draft === false ? '' : '<docStage>DRAFT</docStage>',
    meeting.session ? `<docProponent>${esc(meeting.session)}</docProponent>` : '',
    meeting.date ? `<docTitle>${esc(meeting.date)}</docTitle>` : '',
    meeting.time ? `<docTitle>${esc(meeting.time)}</docTitle>` : '',
  ].join('');

  return (
    `<container name="masthead">` +
    `<container name="governors">${governors}</container>` +
    `<container name="mark" aria-label="${esc(ORG.name)} ${esc(ORG.body)}"></container>` +
    `<container name="session">${session}</container>` +
    `</container>`
  );
}
