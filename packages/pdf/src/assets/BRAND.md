# Board of Governors brand inventory

Filed instruments and the drafting app do not use the same mark.

## Print / PDF letterhead (white paper)

Use dark ink on a transparent ground. A knockout (white-on-black) mark
vanishes on the page.

| Asset | Role |
| --- | --- |
| `logo-main-color.svg` | Corporate wordmark: seal + BLEVINS HOLDINGS. Light ground. |
| `Blevins-Board-of-Governors-Polished.svg` converted to navy | Circular Board seal for the letterhead centre column. |
| existing `board-lockup.png` | Raster fallback already in this folder. |

Do **not** put a committee lockup on a resolution, ordinance, or board
letter. Those documents speak for the Board, not a committee.

## Digital chrome (dark header, app shell)

Use the dark-ground lockups. Accent colour is the committee colour.

| Lockup | Accent | Use |
| --- | --- | --- |
| Board of Governors (no committee name) | navy `#353D4F` | Default app header, full Board packet |
| Committee of the Whole | crimson `#8B2030` | Committee-of-the-whole session |
| Compensation & Talent | green | Standing committee |
| Security & Classified Programs | blue | Standing committee |
| Legal & Regulatory Affairs | deep blue | Standing committee |
| Audit & Risk | light blue | Standing committee |
| Health, Safety & Environment | steel blue | Standing committee |
| Investment & Endowment | teal | Standing committee |
| Philanthropy & Community | gold | Standing committee |
| Ethics & Conduct | teal | Standing committee |
| Technology & Cybersecurity | magenta | Standing committee |
| Enterprise Operations | taupe | Standing committee |
| Governance & Nominating | burgundy | Standing committee |

`logo-main-darkbg.svg` is the white corporate wordmark for a black or navy bar.

## Discard

- The solid black square export is empty; do not check it in.
- The 2–3 MB lockup rasters are source plates. Compress to ~150 KB PNG
  or trace to SVG before they ship in the image.

## Copy into the repo (from this conversation's attachments)

```
packages/pdf/src/assets/board-seal.svg          # navy conversion of the circular seal
packages/pdf/src/assets/board-seal-knockout.svg # white knockout, dark grounds only
apps/web/public/brand/logo-main-color.svg
apps/web/public/brand/logo-main-darkbg.svg
apps/web/public/brand/lockups/
```
