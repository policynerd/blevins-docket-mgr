# Companion: legislative drafting (newbuild)

The Akoma Ntoso drafting suite that used to live only in this monorepo
(`apps/`, `packages/`, root `fly.toml`) is now a **separate application**:

**https://github.com/policynerd/blevins-drafting**

Fly app: `blevins-drafting` (not `beg-docket-manager`).

This repository remains the docket — meetings, calendar, votes, minutes,
budget, procurement, the public record. Copies of `apps/` and `packages/`
may still be present here so existing CI and the current Fly source keep
working until the Fly app is pointed at the companion. Treat
`policynerd/blevins-drafting` as the home for new drafting work.
