# Gap analysis: what stands between this and a system of record

**Assessed:** August 7, 2026 · against the current `main`.

Adapted from the fit-gap analysis carried in `policynerd/blevins-legislative-file-system`
("Civic Ledger"), which benchmarked a clerk workflow against public Legistar
deployments (New York City Council, San Francisco Board of Supervisors),
Granicus Agenda LE, and the New York State Open Legislation / LBDC information
model. The benchmarks and the record model below are that document's; the
status column is not — it has been re-derived against this codebase, which is
considerably further along than the prototype the original measured.

## Where this codebase actually sits

The original analysis opens by saying its subject "is not yet a legislative
system of record" — no persistent data model, no access control, no meeting
event ledger, no publication layer. That framing does not transfer. Most of
what it lists as P0 gaps is built here:

| Original finding | Status here |
| --- | --- |
| No canonical data model | SQLite schema with ~40 tables; every screen reads through `src/repo.js` |
| Matter / MatterVersion is a gap | `matters` + `matter_versions`, snapshot-on-edit, with a diff view |
| No authentication or authorization | Local + Entra SSO, five-rank role ladder (`public → member → staff → clerk → admin`), path-prefix gating |
| Day-of operations not persisted | `votes`, `attendance`, `speaker_requests`, `matter_history`, motions and thresholds on `agenda_items`, live SSE console |
| Minutes are a gap | Generated from roll call, motions and tallies; draft → published |
| Search is a gap | FTS5 over matters with a LIKE fallback |
| Public portal / API is P2 | Public record site, JSON API at `/api/v1`, RSS, CSV export — already shipped |
| Agenda composition is partial | Sections, auto-numbering, drag reorder, templates, and a ready-for-agenda queue |
| Packet assembly is partial | Packet builder assembles reports, attachments and item documents in binding order with tab numbers |

## What is genuinely missing

These are the rows worth keeping. Ordered by what would hurt most in a records
request or a challenge to an adopted ordinance.

### P0 — the evidence chain

**Immutable releases.** Nothing freezes. An agenda can be reordered, an item
retitled, and a packet re-downloaded after members have relied on the version
they were sent, with no record that anything moved. There is no `Publication`
snapshot, no release actor, no posting timestamp, and so no way to answer
"what exactly was posted, and when". This is the single largest gap and it
undercuts every artifact downstream of it.

**Agenda versioning.** `reorderItems()` mutates `sort_order` in place. A
substitution or a withdrawal leaves no trace and carries no reason. The
benchmark expectation is an `AgendaVersion` per release with the changes
between versions recoverable.

**Document custody.** Uploads store `file_path`, `size` and `content_type` —
no content hash, so a file cannot be proven unaltered, and a clean/redline
pair has no recorded relationship or comparison rule. `src/amend.js` computes
comparative prints but does not persist which method produced a given
redline.

**Entity-level audit.** `audit_log` records method, path, IP and user per
request. That answers "who hit this endpoint" but not "who changed this
field, from what, to what, and why" — which is the question an audit actually
asks. Approvals in `workflow_steps` do carry actor and timestamp; nothing
else does.

**Document requirements by type.** The packet builder flags an item with no
material, which is a good start, but there is no rule that an ordinance
*requires* a staff report, or that a contract requires a fiscal note, and no
authorized waiver path when a check fails.

**Retention and legal hold.** Absent entirely. No disposition schedule, no
hold flag, no export built for discovery.

### P1 — making the record publishable

**Accessible outputs.** `src/pdf.js` draws with pdf-lib and emits untagged
PDFs. No structure, no reading order, no alternate-format path.

**The packet is still a listing.** `generatePacket()` names the documents
rather than binding them. `repo.meetings.packet()` now supplies the ordered
contents with tabs already assigned, so this is a build rather than a design
problem.

**Attachment content is not searchable.** FTS5 covers matter title, summary
and text. Nothing extracts text from uploaded files, so a phrase inside a
staff report is invisible to search.

**Media and transcripts.** `meetings.video_url` and per-item `video_ts` exist;
captions, transcripts and transcript-to-item linkage do not.

## Canonical record model

From the source document, retained because it is a useful target shape:

    Jurisdiction / Session
      ├── Body ──< PersonRole
      ├── Matter ──< MatterVersion ──< DocumentVersion
      │     ├──< WorkflowInstance ──< ApprovalStep
      │     ├──< AgendaItem >── AgendaVersion ──< Meeting
      │     └──< Publication
      └── Meeting ──< MeetingEvent ──< Motion / Vote / Attendance / Speaker

The two boxes with no counterpart here are `Publication` and `AgendaVersion`.
`DocumentVersion` exists only for matter text, not for uploaded files.

A released `AgendaVersion`, `Publication`, `DocumentVersion` or finalized
`MeetingEvent` should be immutable; a correction creates a later version
carrying a reason and a link to what it supersedes.

## Acceptance test

The source document proposes reproducing a single docket end to end. Restated
for this system, the workflow is production-ready when a clerk can open one
legislative file and reproduce the exact released package — its approvers,
each source file, every transformation, the agenda placement, the notice
evidence, the meeting action, and the final adopted record — and when a later
correction produces a new release without disturbing the previous one.

Today that fails at the first clause, because nothing was ever released as a
distinct, addressable thing.

## Not carried over

The source repository is a React/TypeScript/Vite prototype whose pages hold
hardcoded sample arrays and perform no data access; its own README describes
the state as "browser-local prototype" and the persistence as a P0 gap. None
of that code transfers to a zero-dependency server-rendered Node application,
and the screens it mocks — bills, committees, representatives, login, profile
— already exist here backed by a real database.

Its two genuinely novel screens, public discussions and constituent surveys,
are mockups with placeholder content and no implementation behind them. They
are also outside what the analysis itself recommends: its closing position is
that the next increment should be "the data and evidence pipeline behind the
existing Agenda assembly, Record assembly, and Meeting day screens — not
additional public-facing pages." That advice applies here too.
