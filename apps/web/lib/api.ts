/**
 * The API, reached through the Next rewrite so the browser stays same-origin.
 */
const BASE = '/api';

const headers = (): HeadersInit => ({ 'content-type': 'application/json' });

const withSession: RequestInit = { credentials: 'same-origin', cache: 'no-store' };

export class NotSignedIn extends Error {}

export function signIn(returnTo = window.location.pathname + window.location.search): void {
  window.location.href = `${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const message = body.error ?? `${res.status} ${res.statusText}`;
    if (res.status === 401) throw new NotSignedIn(message);
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export interface DocumentSummary {
  id: string;
  docType: string;
  title: string;
  position: number;
  version: { id: string; label: string; updatedAt: string } | null;
}

export interface Proposal {
  id: string;
  ref: string;
  title: string;
  templateId: string;
  updatedAt: string;
  documents: DocumentSummary[];
}

export interface User {
  id: string;
  email: string;
  name: string;
  organization: string | null;
}

export interface Template {
  id: string;
  name: string;
  path: string[];
  documents: { docType: string; title: string }[];
}

export interface TemplatePreview extends Template {
  forms: { name: string; text: string }[];
  boardLetter: { num: string; title: string; help: string }[] | null;
  fiscal: { num: string; title: string; help: string }[] | null;
}

export interface Meta {
  signInConfigured: boolean;
  appBaseUrl: string | null;
  chromium: boolean;
  product: string;
  docketSync?: boolean;
}

export interface LegislativeFile {
  id: string;
  ref: string;
  title: string;
  templateId?: string;
  status: string;
  inControl: string;
  agendaDate: string | null;
  sponsors?: string | null;
  enactmentNumber: string | null;
  finalActionAt: string | null;
  updatedAt: string;
}

export interface FileHistoryLine {
  id: string;
  actionAt: string;
  actingBody: string;
  action: string;
  sentTo: string | null;
  result: string | null;
  actionNote: string | null;
  actionText: string | null;
  votes: { memberName: string; vote: string }[];
}

export interface Meeting {
  id: string;
  body: string;
  meetingAt: string;
  location: string | null;
  agendaStatus: string;
  notes: string | null;
}

export interface MeetingDetail extends Meeting {
  items: {
    id: string;
    position: number;
    heading: string | null;
    proposalId: string | null;
    ref?: string;
    title?: string;
    status?: string;
  }[];
}

export type Align = 'start' | 'end' | 'center' | 'justify';

export const api = {
  me: () => fetch(`${BASE}/auth/me`, withSession).then(json<User>),
  signOut: async () => {
    const { entraLogoutUrl } = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      ...withSession,
    }).then(json<{ entraLogoutUrl?: string }>);
    window.location.href = entraLogoutUrl ?? '/';
  },
  meta: () => fetch(`${BASE}/meta`, withSession).then(json<Meta>),
  templates: () => fetch(`${BASE}/templates`, withSession).then(json<Template[]>),
  template: (id: string) =>
    fetch(`${BASE}/templates/${encodeURIComponent(id)}`, withSession).then(json<TemplatePreview>),
  proposals: () =>
    fetch(`${BASE}/proposals`, withSession).then(json<Omit<Proposal, 'documents'>[]>),
  proposal: (id: string) => fetch(`${BASE}/proposals/${id}`, withSession).then(json<Proposal>),
  createProposal: (body: { templateId: string; title: string }) =>
    fetch(`${BASE}/proposals`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      ...withSession,
    }).then(json<Proposal>),
  renameProposal: (id: string, title: string) =>
    fetch(`${BASE}/proposals/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ title }),
      ...withSession,
    }).then(json<Proposal>),
  renameDocument: (id: string, title: string) =>
    fetch(`${BASE}/documents/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ title }),
      ...withSession,
    }).then(json<DocumentSummary>),
  documentHtml: (id: string) =>
    fetch(`${BASE}/documents/${id}/html`, withSession).then(
      json<{
        document: DocumentSummary;
        version: { label: string; contentHash: string };
        html: string;
      }>,
    ),
  editElement: (documentId: string, elementId: string, value?: string, align?: Align) =>
    fetch(`${BASE}/documents/${documentId}/elements/${elementId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({
        ...(value !== undefined ? { value } : {}),
        ...(align !== undefined ? { align } : {}),
      }),
      ...withSession,
    }).then(json<{ label: string; contentHash: string }>),
  versions: (id: string) =>
    fetch(`${BASE}/documents/${id}/versions`, withSession).then(
      json<{ id: string; label: string; note: string | null; createdAt: string }[]>),
  milestones: (id: string) =>
    fetch(`${BASE}/proposals/${id}/milestones`, withSession).then(
      json<{ id: string; label: string; createdAt: string }[]>),
  createMilestone: (id: string, label: string) =>
    fetch(`${BASE}/proposals/${id}/milestones`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ label }),
      ...withSession,
    }).then(json<{ id: string; label: string }>),
  files: () => fetch(`${BASE}/files`, withSession).then(json<LegislativeFile[]>),
  file: (id: string) => fetch(`${BASE}/files/${id}`, withSession).then(json<LegislativeFile>),
  updateFile: (id: string, body: { sponsors?: string; agendaDate?: string | null }) =>
    fetch(`${BASE}/files/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify(body),
      ...withSession,
    }).then(json<LegislativeFile>),
  fileHistory: (id: string) =>
    fetch(`${BASE}/files/${id}/history`, withSession).then(json<FileHistoryLine[]>),
  recordFileAction: (
    id: string,
    body: {
      action: string;
      actingBody: string;
      sentTo?: string;
      actionNote?: string;
      votes?: { memberName: string; vote: string }[];
    },
  ) =>
    fetch(`${BASE}/files/${id}/actions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      ...withSession,
    }).then(json<unknown>),
  meetings: () => fetch(`${BASE}/meetings`, withSession).then(json<Meeting[]>),
  meeting: (id: string) => fetch(`${BASE}/meetings/${id}`, withSession).then(json<MeetingDetail>),
  createMeeting: (body: { body: string; meetingAt: string; location?: string; notes?: string }) =>
    fetch(`${BASE}/meetings`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
      ...withSession,
    }).then(json<Meeting>),
  generateAgenda: (id: string) =>
    fetch(`${BASE}/meetings/${id}/generate`, {
      method: 'POST',
      headers: headers(),
      ...withSession,
    }).then(json<MeetingDetail>),
  publishAgenda: (id: string, status: 'Draft' | 'Final') =>
    fetch(`${BASE}/meetings/${id}/publish`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ status }),
      ...withSession,
    }).then(json<MeetingDetail>),
  legistarCatalog: () =>
    fetch(`${BASE}/legistar/catalog`, withSession).then(
      json<{ bodies: string[]; statuses: string[]; actions: string[]; voteChoices: string[] }>,
    ),
};
