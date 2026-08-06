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

## Fonts (`fonts/`)

House type comes from the corporate design system: **Denton** for display,
**Denton Text** for long-form, **FT Sterling** for the interface.

Only faces whose files are present here are declared in `public/styles.css`.
That rule is not stylistic — a `@font-face` pointing at a file that is not
deployed costs a 404 on every page load, so a face is added to the stylesheet
in the same change that adds its file. `test/app.test.js` asserts it.

| Present | Family | Weight |
| --- | --- | --- |
| `FTSterlingTrial-Light.woff2` / `.otf` | FT Sterling | 300 (also serves 400) |
| `FTSterlingTrial-Medium.woff2` / `.otf` | FT Sterling | 500 (also serves 600–700) |

Denton and Denton Text are **not** here yet, so `--serif` and `--serif-text`
resolve to Georgia — the same fallback the corporate stylesheet degrades to.
Drop the `.otf` files in and add the matching `@font-face` rules to pick them up.

### Two things to know about the FT Sterling files

**They are trial cuts, and trial licences do not cover deployment.** The files
are named `FTSterlingTrial-*` and their name table reads "FT Sterling Trial".
Foundry trial licences are normally evaluation-only and exclude web embedding,
so shipping these to production is a licensing decision for whoever owns the
brand, not a technical one. Replace them with the licensed files before launch;
the filenames and `@font-face` rules can stay as they are.

**They carry 66 glyphs.** Space, comma, period, `0–9`, `A–Z`, `a–z`. Nothing
else — no hyphen, apostrophe, em dash, parenthesis, colon, ampersand or section
sign, and no accented letters. The `unicode-range` descriptor in `styles.css`
states that coverage exactly, so the browser draws everything outside it from
the fallback rather than asking the font for a glyph it does not have. The
seams are mild in practice (punctuation is where two neutral sans faces differ
least), but it is why body text is not yet set entirely in the house face.

When the licensed fonts land, widen `unicode-range` to match their cmap in the
same change — the test reads the font file's own `cmap` table and will fail if
the declared range claims a codepoint the file cannot draw.

To regenerate the `.woff2` files after replacing an `.otf` (about 40% of the
OpenType payload):

```
pip install fonttools brotli
python3 -c "from fontTools.ttLib import TTFont; f=TTFont('X.otf'); f.flavor='woff2'; f.save('X.woff2')"
```
