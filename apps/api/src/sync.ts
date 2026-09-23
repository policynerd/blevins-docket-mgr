/**
 * Push a legislative file to the docket manager so the two apps share one record.
 *
 * Set on the drafting Fly app:
 *   DOCKET_SYNC_URL=https://beg-docket-manager.fly.dev
 *   DOCKET_SYNC_SECRET=<shared secret>
 *
 * The docket app accepts POST /internal/sync/file with header
 *   x-blevins-sync: <same secret>
 */
export interface SyncPayload {
  id: string;
  ref: string;
  title: string;
  status?: string;
  inControl?: string;
  agendaDate?: string | null;
  enactmentNumber?: string | null;
  sponsors?: string | null;
  packetUrl?: string;
}

export async function pushToDocket(payload: SyncPayload): Promise<void> {
  const base = process.env['DOCKET_SYNC_URL'];
  const secret = process.env['DOCKET_SYNC_SECRET'];
  if (!base || !secret) return;
  const url = `${base.replace(/\/$/, '')}/internal/sync/file`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-blevins-sync': secret,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`docket sync failed ${res.status}`);
    }
  } catch (err) {
    console.error('docket sync unreachable', err);
  }
}
