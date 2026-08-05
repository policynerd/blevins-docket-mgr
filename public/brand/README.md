# Brand assets

Drop the board's artwork here and it is served at `/brand/<file>`. Nothing else
is required — the app accepts a local `/brand/…` path anywhere it accepts an
`https://…` URL, so the mark keeps working offline and on first boot.

Set the paths under **Admin → Branding**, or with `ORG_*` environment variables.

| File | Used for | Setting |
| --- | --- | --- |
| `seal.png` (or `.svg`) | The seal on light grounds: sign-in, printed packets, favicon | `logoUrl` / `ORG_LOGO_URL` |
| `seal-light.png` | The seal reversed for dark grounds — the navy sidebar | `logoLightUrl` / `ORG_LOGO_LIGHT_URL` |
| `favicon.png` | Browser tab icon (optional; falls back to `seal.png`) | `faviconUrl` / `ORG_FAVICON_URL` |

## Which artwork goes where

Supply the **seal alone**, not the full lockup, for `seal.png` and
`seal-light.png`. The app already sets the organization name and tagline in
type beside the mark, so a lockup that repeats them renders the name twice.

- **`seal.png`** — the full-colour or black seal, on transparency.
- **`seal-light.png`** — the reversed (white) seal, on transparency. This is the
  one that appears against the navy rail; a dark seal there reads as a smudge.

Square artwork works best: the mark is rendered at 46 px in the sidebar and
64 px on the sign-in page. PNG at 2× (about 128 px) or an SVG both scale well.

If only one file is supplied, it is used everywhere.
