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

The database location defaults to `./data/docket.db`. Override it with the
`DOCKET_DB` environment variable (handy for pointing at a mounted volume):

```bash
DOCKET_DB=/data/docket.db npm start
```

## Configuration

All settings are optional environment variables — see [`.env.example`](.env.example)
for the full list. The two groups you'll most likely set:

**Branding / identity.** Every UI label is derived from `ORG_*` variables, so you
can rebrand the app to your organization without editing code. Defaults describe
a Board of Governors:

| Variable | Default | Controls |
| --- | --- | --- |
| `ORG_NAME` | Board of Governors | Name in the banner, footer, and `<title>` |
| `ORG_TAGLINE` | Legislative Information Center | Sub-line / page title suffix |
| `ORG_PRIMARY_BODY` | Board of Governors | The primary legislative body |
| `ORG_MEMBERS_LABEL` | Board Members | Nav + members-listing label |
| `ORG_CHAIR_TITLE` / `ORG_VICE_CHAIR_TITLE` / `ORG_MEMBER_TITLE` | Chair / Vice Chair / Governor | Member titles |
| `ORG_CLERK_TITLE` / `ORG_CLERK_OFFICE` | Clerk of the Board / Office of the Clerk of the Board | Clerk identity |
| `ORG_MEETING_LOCATION` | Boardroom | Default meeting location |
| `ORG_EMAIL_DOMAIN` | board.gov | Domain for seeded account emails |

Branding can also be edited live in the app at **`/admin/branding`** (Clerk);
saved values are stored in the database and override the env defaults, including
a logo URL and primary color.

**First-boot seeding.** Production starts **empty**. Set `ADMIN_EMAIL` +
`ADMIN_PASSWORD` (≥ 12 chars) to bootstrap a single clerk/admin login, then
build real data in the app. Sample data **and** demo logins are created only
when `ENABLE_DEMO_SEED=true` (local/eval).

**Single sign-on (Microsoft Entra ID).** Set `ENTRA_TENANT_ID`,
`ENTRA_CLIENT_ID`, and `ENTRA_CLIENT_SECRET` to add a “Sign in with Microsoft”
button (OIDC authorization-code flow, id_token verified against Entra’s JWKS).
SSO users are matched to a local account by subject then email; otherwise
sign-in is denied unless `SSO_AUTO_PROVISION_ROLE` is set. Local password login
still works for the bootstrap admin. The redirect URI is
`https://<your-host>/auth/sso/callback`.

## Administration

The Clerk Workspace (`/admin`) and a staff-level Membership area (`/govern`)
provide:

- **Bodies & committees** (`/admin/bodies`) — create, edit, deactivate, or delete
  (delete is refused while meetings/files reference a body).
- **Board membership** (`/govern/members`) — adding or removing a member follows
  **Nominate → Approve → Seat**: the Clerk nominates, a *different* staff member
  (e.g. the Chair) approves, then the Clerk executes the roster change. Every
  step records who acted and when.
- **Branding** (`/admin/branding`) — live identity/theme editing (see above).

## Deploy

This is a **stateful** app (a persistent Node server with a file-backed SQLite
database), so it runs best on a host with a persistent disk rather than a
serverless platform. The repo ships ready-to-use configs.

### Docker (works anywhere)

```bash
docker build -t docket-mgr .
docker run -p 3000:3000 -v docket_data:/data docket-mgr
```

The `-v docket_data:/data` volume keeps the SQLite database across restarts; the
app auto-seeds sample data on first boot when the database is empty. Set
`ADMIN_EMAIL`/`ADMIN_PASSWORD` (or `ENABLE_DEMO_SEED=true`) so login accounts are
created too — see [Configuration](#configuration).

### Render

A `render.yaml` Blueprint is included. Create a new **Blueprint** in Render
pointing at this repo — it provisions a Docker web service with a 1 GB
persistent disk mounted at `/data`. (Persistent disks require a paid instance
type; Render's free tier has no disk.)

### Fly.io

```bash
fly launch --no-deploy
fly volumes create docket_data --size 1 --region iad
fly deploy
```

`fly.toml` wires the `docket_data` volume to `/data` and serves over HTTPS.

### Operating notes (stateful SQLite)

- **Health check:** `GET /healthz` returns `{"status":"ok"}` (503 if the DB is
  unreachable). Point your platform's health check / uptime monitor at it for
  automatic restart and alerting.
- **Single writer:** the database is one file on one volume — run **exactly one
  instance**. Do not scale to multiple machines against the same volume.
- **Backups:** your data *is* `/data/docket.db`. Use your platform's volume
  snapshots (e.g. Fly takes daily snapshots automatically) or periodically copy
  the file. Restoring = restoring the volume.

> **Why not Vercel?** Vercel runs stateless serverless functions with no
> persistent local disk, so file-backed SQLite writes would not survive between
> requests. Running here would require refactoring to functions **and** swapping
> SQLite for a hosted database (e.g. Turso/libSQL or Postgres). The hosts above
> run the code unchanged.

## Data model

| Table | Purpose |
| --- | --- |
| `matters` | Legislative files (ordinances, resolutions, motions, …) |
| `matter_sponsors` | Primary/co-sponsors per file |
| `matter_history` | Workflow actions (introduced, referred, adopted, …) |
| `attachments` | Documents linked to a file |
| `bodies` / `body_members` | Board, committees, commissions & membership |
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
