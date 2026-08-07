# Fit-gap analysis: Blevins Board of Governors docket manager

**Assessed:** August 7, 2026 against `main` — 49 tables, 242 routes, ~9,400
lines of application code, 45 tests.

**Method:** the benchmark set and workstream breakdown come from the fit-gap
analysis in `policynerd/blevins-legislative-file-system`, which measured a
clerk workflow against public Legistar deployments (New York City Council,
San Francisco Board of Supervisors), Granicus Agenda LE, and the New York
State Open Legislation / LBDC information model. Every status below was
re-derived against this codebase with a file-level audit; none was carried
over.

**Status meanings.** *Fit* — the capability is operational. *Partial* — it
works but is missing something a benchmark deployment would require.
*Gap* — it needs to be designed and built.

---

## Executive finding

This is a working legislative information system, not a prototype. It holds a
canonical model, real authentication, a public record site, a JSON API, and
a day-of console. Against the benchmark set it is **ahead** in several places
the benchmarks do not cover at all — appropriation-level budget tracking,
procurement and bid intake, written consents, codification of an internal
code with as-of reconstruction, and an org chart down to unit leaders.

The weakness is narrow and specific: **nothing is ever released.** There is no
artifact in this system that is fixed, addressable, and provably unchanged
after the moment it was distributed. An agenda can be reordered after members
have relied on it; an uploaded document has no content hash; a matter version
does not record who created it; and the audit log records HTTP requests, not
changes to records.

Everything that would be asked for in a public-records request or a challenge
to an adopted ordinance sits downstream of that. It is one coherent gap, not
fifteen scattered ones, and it is the whole of the P0 work.

---

## Benchmark capabilities

| Benchmark | What it proves should exist | Implication |
| --- | --- | --- |
| Granicus Agenda LE | Configurable submission forms, workflow routing, granular permissions, template-generated agendas/minutes, public posting, in-meeting roll call and votes | Agenda assembly must be a governed workflow, not a checklist |
| NYC Council Legistar meeting detail | A final meeting record joining metadata, published agenda, minutes, video, transcript, attachments, and hundreds of items | The meeting is the primary record container; every item needs a stable link to its source matter and evidence |
| SF Legislative Research Center | Search and calendar views joining agendas, minutes, attachment content, file history, media, sponsors, alerts, exports | Records must stay searchable after the meeting, including inside attachments |
| NYS Open Legislation | Bills, laws, committee agendas, calendars, transcripts published from LBDC-originated data | The canonical model must preserve version, action, agenda reference, session, and provenance |
| NYS bill + agenda APIs | Amendment versions, ordered actions, prior-session versions, published/processed change feeds | Releases and amendments need immutable timestamped versions and a change feed |

---

## Fit-gap matrix

### Core legislative workflow

| Workstream | Status | Evidence | Gap to close |
| --- | --- | --- | --- |
| Matter / docket intake | **Fit** | `matters` with `insertNumbered()` assigning receipt-ordered YYMMXX file numbers, collision-safe past 99; sponsors, owning body, topics, fiscal note, `matter_relations` (Related / Companion / Amends / Supersedes) | — |
| Matter versioning | **Partial** | `matter_versions` snapshots outgoing text on edit; `src/diff.js` renders ins/del runs | No actor on a version — `matter_versions` has no `created_by`. "Who changed this text" is unanswerable |
| Agenda composition | **Partial** | Sections, auto-numbered `1A`/`1B`, drag reorder, templates, ready-for-agenda queue scoped by body and live status | No `AgendaVersion`. `reorderItems()` mutates `sort_order` in place; a substitution or withdrawal leaves no trace and carries no reason |
| Packet assembly | **Partial** | `repo.meetings.packet()` gathers reports, attachments and item documents in binding order with tab numbers; builder flags items with no material | No document requirements by matter type, no authorized waiver path. `generatePacket()` still lists documents rather than binding them |
| Approval routing | **Partial** | `workflow_steps` with `seq`, `role`, `assignee_id`, `acted_by`, `acted_at`, `notes`; approvals inbox with badge count | No delegation, and no link from a decision to the artifact it was made against — an approval does not pin the version it approved |
| Day-of operations | **Fit** | Roll call and attendance, mover/seconder/motion text, `vote_threshold`, per-member votes, speaker queue, live SSE console, recorded results | State is mutated in place rather than appended. A corrected vote overwrites; there is no `MeetingEvent` ledger |
| Minutes and action record | **Fit** | Generated from roll call, motions and tallies; draft → published; preserved on the meeting | — |
| Ordinance / amendment versioning | **Fit** | `src/legisdoc.js` parses a provision tree with stable ids; `src/amend.js` produces comparative prints and codifies on enactment only; `code_sections` / `code_amendments` / `code_history` support as-of reconstruction | Comparison method is computed but not persisted against the redline it produced |

### Evidence and custody

| Workstream | Status | Evidence | Gap to close |
| --- | --- | --- | --- |
| Notice and release | **Gap** | — | Nothing freezes. No `Publication` record, no release actor, no posting timestamp, no correction/republish path. The largest gap in the system |
| Document custody | **Gap** | `attachments` carries `file_path`, `size`, `content_type`; served from `/files/:id` | No content hash, so no file can be shown unaltered. No `DocumentVersion`, no recorded clean↔redline relationship |
| Audit | **Partial** | `repo.audit.record()` logs user, method, path and IP for every non-GET request | Request-level, not entity-level: it cannot say which field changed, from what, to what. **And it is gated on `user` being truthy, so anonymous state changes — public comments, speaker sign-ups — leave no trace at all** (`server.js:2191`) |
| Retention and legal hold | **Gap** | — | No disposition schedule, no hold flag, no export shaped for discovery |

### Publication and access

| Workstream | Status | Evidence | Gap to close |
| --- | --- | --- | --- |
| Search and retrieval | **Partial** | FTS5 over `file_number, title, summary, full_text, body_html`, LIKE fallback where FTS5 is absent | Attachment content is not indexed — a phrase inside an uploaded staff report is invisible |
| Accessible official outputs | **Gap** | `src/pdf.js` draws with pdf-lib | Untagged PDFs: no structure, no reading order, no alternate-format workflow, no output manifest |
| Video, audio, transcript | **Partial** | `meetings.video_url`, per-item `video_ts` | No captions, transcripts, or transcript-to-item linkage |
| Public portal, alerts, exports | **Fit** | Public record site, calendar, iCal, RSS (list and per-matter), CSV, saved searches, watches, daily digest | Alerts are inert without SMTP configured — correct, but means the feature is unproven in production until it is |
| Interoperable API | **Partial** | `/api/v1` with `matters`, `events`, `bodies`, `persons` — Open Civic Data shaped | Read-only and unauthenticated by design (public record), but there is no change feed and no versioned update stream |
| Security and administration | **Partial** | Local + Entra SSO, five-rank ladder, DB-backed hashed sessions, login throttling, CSRF origin check, per-IP throttles, honeypots, CSP/nosniff/HSTS | No MFA, no tenant isolation, no permission matrix beyond the rank ladder. `/api` sits outside `gate()` — intended, but it means the ladder is not the only access path and that should be deliberate |

### Beyond the benchmark

Capabilities with no counterpart in the benchmark set, all operational:
appropriation-code budget rollup with adopted/amended/actual, procurement
solicitations and sealed bid intake, Adobe Acrobat Sign written consents,
board applications, proposals and endorsements, policy library, and an org
chart to unit-leader level.

---

## Canonical record model

The target shape, and what exists against it:

    Jurisdiction / Session          ← no session concept
      ├── Body ──< PersonRole       ✔ bodies, body_members, people
      ├── Matter ──< MatterVersion  ✔ matters, matter_versions (no actor)
      │     │         ──< DocumentVersion   ✘ uploads have no version or hash
      │     ├──< WorkflowInstance ──< ApprovalStep   ✔ workflow_steps
      │     ├──< AgendaItem >── AgendaVersion ──< Meeting
      │     │        ✔ agenda_items            ✘ no AgendaVersion
      │     └──< Publication        ✘ nothing
      └── Meeting ──< MeetingEvent ──< Motion / Vote / Attendance / Speaker
             ✔ meetings    ✘ no ledger   ✔ all four exist, mutated in place

Three boxes are missing: `Publication`, `AgendaVersion`, and `MeetingEvent`.
`DocumentVersion` exists for matter text only, not for uploaded files. There
is no session/term concept, so nothing carries across a board term.

A released `AgendaVersion`, `Publication`, `DocumentVersion` or finalised
`MeetingEvent` should be immutable; a correction creates a later version with
a reason and a link to what it supersedes.

---

## Recommended sequence

**P0 — close the evidence chain.** These four are one piece of work and
should be done together, because each is weakened without the others.

1. **Release locks.** A `Publication` row per released agenda or packet:
   version, actor, posting timestamp, content manifest. Freeze what it points
   at. Corrections create a successor with a reason.
2. **Agenda versioning.** `AgendaVersion` per release; record every add,
   remove and reorder against it with a reason.
3. **Content hashing.** SHA-256 on upload, stored on the row, verified on
   read. Pin the clean↔redline relationship and the comparison method that
   produced it.
4. **Entity-level audit.** Move from request logging to change records
   carrying actor, entity, field, before, after, and reason — including for
   anonymous submissions, which are currently unlogged.

**P1 — make the record publishable.**

5. Bind the packet: `generatePacket()` already receives ordered contents with
   tabs assigned; it needs to render report and item text rather than names.
6. Tagged PDF output with reading order and an output manifest.
7. Extract text from uploads into the FTS index.
8. Document requirements by matter type, with an authorized waiver path.

**P2 — completeness.**

9. Retention schedules, legal hold, and a discovery-shaped export.
10. Change feed on `/api/v1` modelled on Open Legislation's published/
    processed streams.
11. Transcript ingestion with per-item timecodes.
12. A session/term concept so records carry across board terms.

---

## Acceptance test

The workflow is production-ready when a clerk can open one legislative file
and reproduce the exact released package — its approvers, each source file,
every transformation, the agenda placement, the notice evidence, the meeting
action, and the final adopted record — and when a later correction produces a
new release without disturbing the previous one.

Today that fails at the first clause: nothing was ever released as a distinct,
addressable thing. Every other capability needed to pass it is already built.
