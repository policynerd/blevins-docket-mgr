# What this PR actually plugs in

Earlier PRs left libraries on disk. This one registers them.

- `schema-extra.js` creates publications, agenda_versions, record_changes,
  spend_requests, and the matter instrument/assent columns.
- `src/http/wire.js` is mounted from the kernel. Routes:
  - `/spend` — file, submit, approve, post, void
  - `/admin/legislation/:fn/instrument` — citations / recitals / formula
  - `/admin/matters/:id/assent`
  - `/member/agenda-items/:id/move|second`
- Publishing an agenda also freezes a custody snapshot.
- Signed-in chrome gets a desk strip (inbox, moved watches, spend).
- Display board is not touched.
