/**
 * The API, reached through the Next rewrite so the browser stays same-origin.
 *
 * The caller identity is a header today, matching the API's placeholder auth.
 * It is read from the environment rather than typed into a form so that
 * swapping it for a real signed session touches this file and nothing else.
 */
const BASE = '/api';

function headers(): HeadersInit {
  const id = process.env['NEXT_PUBLIC_USER_ID'];
  return id
    ? { 'content-type': 'application/json', 'x-user-id': id }
    : { 'content-type': 'application/json' };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
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

export interface Template {
  id: string;
  name: string;
  path: string[];
  documents: { docType: string; title: string }[];
}

export const api = {
  templates: () => fetch(`${BASE}/templates`).then(json<Template[]>),
  proposals: () => fetch(`${BASE}/proposals`).then(json<Omit<Proposal, 'documents'>[]>),
  proposal: (id: string) => fetch(`${BASE}/proposals/${id}`).then(json<Proposal>),
  createProposal: (body: { templateId: string; title: string }) =>
    fetch(`${BASE}/proposals`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    }).then(json<Proposal>),
  documentHtml: (id: string) =>
    fetch(`${BASE}/documents/${id}/html`).then(
      json<{
        document: DocumentSummary;
        version: { label: string; contentHash: string };
        html: string;
      }>,
    ),
  editElement: (documentId: string, elementId: string, value: string) =>
    fetch(`${BASE}/documents/${documentId}/elements/${elementId}`, {
      method: 'PATCH',
      headers: headers(),
      body: JSON.stringify({ value }),
    }).then(json<{ label: string; contentHash: string }>),
  versions: (id: string) =>
    fetch(`${BASE}/documents/${id}/versions`).then(
      json<{ id: string; label: string; note: string | null; createdAt: string }[]>,
    ),
  milestones: (id: string) =>
    fetch(`${BASE}/proposals/${id}/milestones`).then(
      json<{ id: string; label: string; createdAt: string }[]>,
    ),
  createMilestone: (id: string, label: string) =>
    fetch(`${BASE}/proposals/${id}/milestones`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ label }),
    }).then(json<{ id: string; label: string }>),
};
