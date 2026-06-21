# blevins-docket-mgr

A **legislative docket & agenda management system** — an open, self-hosted
application modeled on the core capabilities of legislative platforms like
Granicus **Legistar**. It tracks legislation from introduction through final
action, manages meeting calendars and agendas, records votes, and publishes a
searchable public records portal with a JSON Web API.

> This is an original implementation of the standard public-sector
> legislative-management domain. It is not affiliated with or derived from any
> proprietary product.

## Why it exists / comparison to Legistar

Legistar centers on a handful of concepts. This project implements that same
core so a clerk's office can run its docket without a commercial license:

| Capability | Legistar | This project |
| --- | --- | --- |
| Legislative files (Matters) with type, status, sponsors, history, attachments | ✅ | ✅ |
| Legislative bodies & committees with membership | ✅ | ✅ |
| People / elected officials directory | ✅ | ✅ |
| Meeting calendar, agendas & agenda sections | ✅ | ✅ |
| Roll-call votes & tallies | ✅ | ✅ |
| Status workflow (Introduced → In Committee → Passed/Enacted …) | ✅ | ✅ |
| Searchable public portal (InSite-style) | ✅ | ✅ |
| Read JSON Web API | ✅ | ✅ (`/api/v1`) |
| Clerk admin workspace (create files, record actions, build agendas, capture votes) | ✅ | ✅ |
| SaaS hosting, e-signature, video streaming, granular roles/SSO | ✅ | ❌ (out of scope) |

## Highlights

- **Zero runtime dependencies.** Uses Node's built-in HTTP server and the
  built-in `node:sqlite` module — no `npm install`, no native builds.
- **Self-seeding.** On first run it builds a realistic fictional municipality
  (council + committees, officials, ~10 legislative files, meetings with
  agendas and recorded votes) so every screen is populated.
- **Public portal + clerk admin + Web API** in one small codebase.

## Requirements

- Node.js **≥ 22.5** (for the built-in `node:sqlite` module).

## Run it

```bash
npm start          # starts the server on http://localhost:3000
```

Then open:

- Public portal — http://localhost:3000/
- Clerk admin    — http://localhost:3000/admin
- JSON Web API   — http://localhost:3000/api/v1

To rebuild the demo data from scratch:

```bash
npm run reset
```

Set a custom port with `PORT=8080 npm start`.

## Data model

| Table | Purpose |
| --- | --- |
| `matters` | Legislative files (ordinances, resolutions, motions, …) |
| `matter_sponsors` | Primary/co-sponsors per file |
| `matter_history` | Workflow actions (introduced, referred, adopted, …) |
| `attachments` | Documents linked to a file |
| `bodies` / `body_members` | Council, committees, commissions & membership |
| `people` | Elected officials and appointees |
| `meetings` / `agenda_items` | Calendar, agendas & agenda sections |
| `votes` | Per-member roll-call votes on agenda items |

## Web API

```
GET /api/v1                         # service index
GET /api/v1/matters                 # ?q= &type= &status= &body_id= &sponsor_id= &limit=
GET /api/v1/matters/{fileNumberOrId}
GET /api/v1/events                  # meetings
GET /api/v1/events/{id}             # meeting + agenda + votes
GET /api/v1/bodies     /api/v1/bodies/{id}
GET /api/v1/persons    /api/v1/persons/{id}
```

## Project layout

```
server.js            HTTP server + route table
src/db.js            SQLite connection + schema
src/repo.js          Data-access layer (queries)
src/seed.js          Demo-data seeder
src/api.js           JSON Web API handlers
src/util.js          HTML-escaping, templating & HTTP helpers
src/views/           Server-rendered HTML (layout, public pages, admin)
public/styles.css    Stylesheet
```

## License

MIT
