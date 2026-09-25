'use client';

import { useEffect, useState } from 'react';
import { api, type LegislativeFile, type Proposal } from '../../../lib/api';

export function ClerkDesk({
  id,
  proposal,
  file,
  onChanged,
}: {
  id: string;
  proposal: Proposal;
  file?: LegislativeFile;
  onChanged: () => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [sponsors, setSponsors] = useState(file?.sponsors ?? '');
  const [action, setAction] = useState('Referred');
  const [body, setBody] = useState(file?.inControl ?? 'Board of Governors');
  const [sentTo, setSentTo] = useState('Committee of the Whole');
  const [note, setNote] = useState('');
  const [actions, setActions] = useState<string[]>([]);
  const [bodies, setBodies] = useState<string[]>([]);
  const [votes, setVotes] = useState<{ memberName: string; vote: string }[]>([]);
  const [choices, setChoices] = useState<string[]>(['Aye', 'No', 'Abstain', 'Absent', 'Recused']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [ok, setOk] = useState<string>();

  useEffect(() => {
    setTitle(proposal.title);
    setSponsors(file?.sponsors ?? '');
    setBody(file?.inControl ?? 'Board of Governors');
  }, [proposal.title, file?.sponsors, file?.inControl]);

  useEffect(() => {
    api
      .legistarCatalog()
      .then((c) => {
        setActions(c.actions.filter((a) => a !== 'Created'));
        setBodies(c.bodies);
        setChoices(c.voteChoices);
      })
      .catch(() => {});
  }, []);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(undefined);
    setOk(undefined);
    try {
      await fn();
      setOk(message);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const needsTarget = action === 'Referred' || action === 'Placed on Agenda' || action === 'Held in Committee';

  return (
    <section className="card clerk-desk" style={{ padding: '1.25rem', marginTop: '1.25rem' }}>
      <h2>Clerk desk</h2>
      <p className="ref">Rename the matter, record a Legistar action, take a roll, publish the record.</p>
      {error ? <div className="error">{error}</div> : null}
      {ok ? <p className="ref">{ok}</p> : null}

      <div className="field">
        <span>Title</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <span>Sponsors</span>
        <input value={sponsors} onChange={(e) => setSponsors(e.target.value)} />
      </div>
      <button
        type="button"
        disabled={busy || !title.trim()}
        onClick={() =>
          run(async () => {
            await api.renameProposal(id, title.trim());
            await api.updateFile(id, { sponsors: sponsors.trim() || undefined });
          }, 'File updated.')
        }
      >
        Save title and sponsors
      </button>

      <hr />

      <div className="field">
        <span>Action</span>
        <select value={action} onChange={(e) => setAction(e.target.value)}>
          {actions.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Acting body</span>
        <select value={body} onChange={(e) => setBody(e.target.value)}>
          {bodies.map((b) => (
            <option key={b}>{b}</option>
          ))}
        </select>
      </div>
      {needsTarget ? (
        <div className="field">
          <span>Send to</span>
          <select value={sentTo} onChange={(e) => setSentTo(e.target.value)}>
            {bodies.map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="field">
        <span>Note</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} />
      </div>

      <h3>Roll call (optional)</h3>
      {votes.map((row, i) => (
        <div key={i} className="vote-edit">
          <input
            placeholder="Member"
            value={row.memberName}
            onChange={(e) => {
              const next = [...votes];
              next[i] = { ...row, memberName: e.target.value };
              setVotes(next);
            }}
          />
          <select
            value={row.vote}
            onChange={(e) => {
              const next = [...votes];
              next[i] = { ...row, vote: e.target.value };
              setVotes(next);
            }}
          >
            {choices.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
      ))}
      <button type="button" onClick={() => setVotes([...votes, { memberName: '', vote: 'Aye' }])}>
        Add vote
      </button>

      <div className="clerk-actions">
        <button
          className="primary"
          type="button"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await api.recordFileAction(id, {
                action,
                actingBody: body,
                sentTo: needsTarget ? sentTo : undefined,
                actionNote: note || undefined,
                votes: votes.filter((v) => v.memberName.trim()),
              });
              if (action === 'Adopted' || action === 'Adopted as Amended') {
                await api.createMilestone(id, `${action} text`);
              }
            }, `${action} recorded.`)}
        >
          Record action
        </button>
        <button type="button" disabled={busy} onClick={() => run(() => api.publishFile(id, 'Published from clerk desk'), 'Record published.')}>
          Publish record
        </button>
      </div>
    </section>
  );
}
