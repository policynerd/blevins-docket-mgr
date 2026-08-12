# Feature Comparison — Civic Legislative & Agenda Management Systems

How this project compares with the systems that state legislatures, county
governments, and local legislative bodies actually use, and where we can
compete well. Surveyed: **Granicus Legistar** (the county/large-city standard),
**CivicPlus CivicClerk**, **PrimeGov** (now Granicus "OneMeeting"),
**Diligent BoardDocs / Diligent Community** (school & special-district boards),
**eScribe**, **Municode Meetings**, and the feature set common to **state
legislature information systems** (bill status, amendments, fiscal notes) as
surfaced by trackers like FiscalNote, BillTrack50, and Quorum.

Status: ✅ have · 🟡 partial · 🚧 in progress on this branch · ❌ not planned / later

## 1. Agenda & meeting lifecycle

| Function (who has it)                                                      | Us  | Notes                                                                                                        |
| -------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------ |
| Agenda item submission by staff (all)                                      | ✅  | Clerk workspace + member file submission                                                                     |
| Configurable approval/routing workflow (Legistar's flagship)               | ✅  | Template-based steps, act/approve/return, per-role                                                           |
| Agenda assembly: sections, ordering, numbering (all)                       | ✅  | Drag reorder, section grouping, agenda templates                                                             |
| Agenda templates (all)                                                     | ✅  | Editable `Section \| Title \| Type` template                                                                 |
| Action/Discussion/Information item types (Robert's Rules)                  | ✅  |                                                                                                              |
| Agenda packet compilation to PDF (all)                                     | ✅  | pdf-lib packet + print views                                                                                 |
| Publish to a public portal (all)                                           | ✅  | Public site is the core of the app                                                                           |
| Minutes generation from agenda + actions (Legistar, CivicClerk, BoardDocs) | ✅  | Generated draft + rich-text editing + adoption                                                               |
| Roll call & attendance (all)                                               | ✅  |                                                                                                              |
| Motions, movers, seconders (all)                                           | ✅  |                                                                                                              |
| In-meeting electronic voting, live tally (CivicClerk, PrimeGov)            | ✅  | Live voting with member devices + clerk console                                                              |
| Vote thresholds — majority, ⅔, majority-of-full-body (Legistar)            | ✅  |                                                                                                              |
| Live meeting display page for the chamber (CivicClerk)                     | ✅  | `/live` views                                                                                                |
| Video streaming + per-item video timestamps (Granicus's moat)              | ❌  | Only a `video_url` per meeting; streaming infra is out of scope for a zero-dep app — link out to YouTube/PEG |
| Closed captioning / transcription (Diligent Community)                     | ❌  | Out of scope                                                                                                 |
| Public comment (eComment) on agenda items (Granicus, CivicClerk)           | 🚧  | Being added: comment + position on published items, moderation queue                                         |
| Request-to-speak queue (Granicus)                                          | ❌  | Later: builds on public comment                                                                              |

## 2. Legislative files (matters)

| Function                                                                       | Us    | Notes                                                                                |
| ------------------------------------------------------------------------------ | ----- | ------------------------------------------------------------------------------------ |
| File numbering (all)                                                           | ✅    | All-numeric YYMMXX, receipt-ordered, auto-assigned                                   |
| Legislative history per file (Legistar is the reference)                       | ✅    | Action/result/body/meeting per step                                                  |
| Status pipeline (Draft → Introduced → … → Enacted)                             | ✅    |                                                                                      |
| Sponsors & co-sponsors (state LIS, Legistar)                                   | ✅    |                                                                                      |
| Committee/body referral (state LIS, Legistar)                                  | ✅    | Body assignment + history                                                            |
| **Text versioning** — introduced vs. amended vs. adopted (state LIS, Legistar) | 🚧    | Being added: snapshot on each text edit, version history                             |
| Side-by-side amendment comparison (state trackers)                             | ❌    | Later: needs versioning first; a diff view is a natural follow-on                    |
| Fiscal notes / fiscal impact (state LIS)                                       | ✅    | Fiscal impact per matter, tied to budget lines — most local products don't have this |
| Attachments (all)                                                              | 🟡→🚧 | Today: name+URL. Being added: real file uploads stored on the volume                 |
| Staff reports authored in-app (Legistar, CivicClerk)                           | ✅    | WYSIWYG editor + one-click draft scaffold                                            |
| Topic/index tagging (Legistar "indexes")                                       | ✅    |                                                                                      |
| Bulk import / data migration (vendor onboarding service)                       | 🚧    | Roster import exists; CSV matter import being added                                  |

## 3. Search, records & transparency

| Function                                                                   | Us    | Notes                                                                          |
| -------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------ |
| Public searchable archive (all; BoardDocs sells this hard)                 | ✅    |                                                                                |
| **Full-text search** across file text/reports (Legistar InSite, BoardDocs) | 🟡→🚧 | Today: LIKE over title/number/summary. Being added: SQLite FTS5 over full text |
| Filter by type/status/body/sponsor/topic/date (Legistar InSite)            | ✅    | Plus sortable columns and pagination                                           |
| Open data: JSON API, CSV export, RSS (Legistar Web API)                    | ✅    | `/api/v1`, CSV, RSS, iCal                                                      |
| Calendar + iCal feed (all)                                                 | ✅    |                                                                                |
| Policy book / code of policies (BoardDocs, Municode)                       | ✅    | Policies module with categories, adoption links                                |
| Records retention rules (BoardDocs)                                        | ❌    | Everything is retained; formal retention schedules later                       |
| ADA-friendly output (all vendors advertise this)                           | 🟡    | Semantic HTML helps; needs an a11y pass                                        |

## 4. People & governance

| Function                                                          | Us  | Notes                                                              |
| ----------------------------------------------------------------- | --- | ------------------------------------------------------------------ |
| Member roster, districts, parties, photos (all)                   | ✅  |                                                                    |
| Boards & commissions with membership terms (CivicClerk, PrimeGov) | 🟡  | Bodies + members + roles exist; term expiry/vacancy tracking later |
| Citizen applications to boards (CivicClerk)                       | ❌  | Later: pairs with public comment infrastructure                    |
| Member offices & staff (Legistar)                                 | ✅  |                                                                    |
| Seat/remove workflow with approvals                               | ✅  | Nominate → Approve → Seat                                          |
| Board goals / strategic plans (Diligent Community)                | ❌  | Later                                                              |
| Budget with line items tied to legislation                        | ✅  | Uncommon in this product class                                     |

## 5. Platform & operations

| Function                                                    | Us  | Notes                                                                    |
| ----------------------------------------------------------- | --- | ------------------------------------------------------------------------ |
| SSO (all vendors)                                           | ✅  | Microsoft Entra ID (OIDC)                                                |
| Role-based access (all)                                     | ✅  | public/member/staff/clerk/admin                                          |
| Email notifications & subscriptions (all)                   | 🟡  | RSS/iCal exist; email needs an SMTP relay — deliberate roadmap item      |
| Watch lists / bill tracking for the public (state trackers) | ❌  | Later: "follow this file" with email or feed                             |
| Audit log of clerk actions (vendors' enterprise tier)       | ❌  | Later                                                                    |
| Backups                                                     | ✅  | Daily `VACUUM INTO` on-volume + admin download; Fly snapshots underneath |

## What we do well vs. the vendors

1. **Zero-friction stack** — one Node process, one SQLite file, one $2/mo Fly
   machine. Every vendor above is a five-to-six-figure annual contract.
2. **Fiscal integration** — matters carry fiscal impact tied to budget lines;
   the agenda-management vendors largely don't touch budgets.
3. **Live voting without extra hardware** — CivicClerk/PrimeGov sell voting
   modules; ours is built in and works from any member device.
4. **Own your data** — the whole record is a SQLite file you can download from
   the admin page. No export negotiation with a vendor.

## Deliberately out of scope

Video streaming/captioning (link out instead), records-request management
(GovQA territory), lobbying disclosure, codification typesetting (Municode's
publishing business), and multi-tenant SaaS features.
