# Brand assets

Drop the board's artwork here and it is served at `/brand/<file>`. Nothing else
is required — the app accepts a local `/brand/…` path anywhere it accepts an
`https://…` URL, so the mark keeps working offline and on first boot.

Set the paths under **Admin → Branding**, or with `ORG_*` environment variables.

| File | Used for | Setting |
| --- | --- | --- |
| `seal.png` (or `.svg`) | The seal on light grounds — the sign-in page; also the favicon fallback | `logoUrl` / `ORG_LOGO_URL` |
| `seal-light.png` | The seal reversed for dark grounds — the navy sidebar | `logoLightUrl` / `ORG_LOGO_LIGHT_URL` |
| `favicon.png` | Browser tab icon (optional; falls back to `seal.png`) | `faviconUrl` / `ORG_FAVICON_URL` |

Printed agenda packets are text-only today and carry no seal, and the print
stylesheet hides the sidebar mark — so nothing here affects PDF output.

| `lockup-light.png` | A horizontal lockup shown **alone** in the sidebar, replacing the seal-and-name masthead | `logoLockupUrl` / `ORG_LOGO_LOCKUP_URL` |

## Which artwork goes where

There are two ways to brand the sidebar; pick one.

**Seal beside the name (default).** Supply the **seal alone** for `seal.png`
and `seal-light.png`. The app sets the organization name and tagline in type
next to it, so artwork that already contains the name would render it twice.

**A horizontal lockup.** If your lockup already carries the name — a seal, a
rule, and the wordmark — set `logoLockupUrl` instead. The sidebar then shows
that image across the full width of the rail and omits the name and tagline,
since the artwork supplies them. Use the reversed (white) version: the rail is
navy. A wide aspect ratio is expected; the image scales to the rail width.

- **`seal.png`** — the full-colour or black seal, on transparency.
- **`seal-light.png`** — the reversed (white) seal, on transparency. This is the
  one that appears against the navy rail; a dark seal there reads as a smudge.

Square artwork works best: the mark is rendered at 46 px in the sidebar and
64 px on the sign-in page. PNG at 2× (about 128 px) or an SVG both scale well.

If only one file is supplied, it is used everywhere.
