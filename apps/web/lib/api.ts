/**
 * The API, reached through the Next rewrite so the browser stays same-origin.
 *
 * Authentication is the session cookie the API sets at the end of an Entra
 * sign-in. Nothing here carries an identity: the browser cannot read the
 * cookie (it is httpOnly) and cannot forge one, which is the entire reason the
 * `x-user-id` header this replaced had to go.
 */
const BASE = '/api';

const headers = (): HeadersInit => ({ 'content-type': 'application/json' });

/** Send the cookie, and never a stale cached answer for a signed-in view. */
const withSession: RequestInit = { credentials: 'same-origin', cache: 'no-store' };

/** Thrown when the API says we are not signed in. */
export class NotSignedIn extends Error {}

/**
 * Send the browser to sign in, coming back to where it stands now.
 *
 * A full navigation rather than a fetch: the OIDC redirect chain has to happen
 * in the address bar, and an XHR cannot follow it.
 */
export function signIn(returnTo = window.location.pathname + window.location.search): void {
  window.location.href = `${BASE}/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const message = body.error ?? `${res.status} ${res.statusText}`;
    // 401 is not an error the page can do anything about; it means the session
    // ran out. 403 is different — the caller is signed in and simply may not
    // do this — so it must not be turned into a sign-in loop.
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

export const api = {
  me: () => fetch(`${BASE}/auth/me`, withSession).then(json<User>),
  signOut: async () => {
    const { entraLogoutUrl } = await fetch(`${BASE}/auth/logout`, {
      method: 'POST',
      ...withSession,
    }).then(json<{ entraLogoutUrl?: string }>);
    // Ending our session leaves the browser signed in to Microsoft, so the
    // next visit signs straight back in with no prompt. On a shared machine
    // that is not a sign-out.
    window.location.href = entraLogoutUrl ?? '/';
  },
  templates: () => fetch(`${BASE}/templates`, withSession).then(json<Template[]>),
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
  documentHtml: (id: string) =>
    fetch(`${BASE}/documents/${id}/html`, withSession).then(
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
      ...withSession,
    }).then(json<{ label: string; contentHash: string }>),
  versions: (id: string) =>
    fetch(`${BASE}/documents/${id}/versions`, withSession).then(
      json<{ id: string; label: string; note: string | null; createdAt: string }[]>,
    ),
  milestones: (id: string) =>
    fetch(`${BASE}/proposals/${id}/milestones`, withSession).then(
      json<{ id: string; label: string; createdAt: string }[]>,
    ),
  createMilestone: (id: string, label: string) =>
    fetch(`${BASE}/proposals/${id}/milestones`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ label }),
      ...withSession,
    }).then(json<{ id: string; label: string }>),
};
