# How the vote is taken, how the act is written

## Legistar voting (LiveManager / Legislate)

Already in this system: clerk opens the item, states the motion, opens the
roll, members vote Yea/Nay/Abstain from `/live`, thresholds, ledger,
certification, consent calendar.

What Legislate adds that a clerk typing names does not: the member on the
roster says **I move** or **I second** from their own seat. That is now a
route (`POST /member/agenda-items/:id/move|second`). The mover cannot second
themselves. The roll still opens only when the clerk opens it.

The chamber *display* is unchanged. This is the member console.

## Commission drafting (Joint Practical Guide / LEOS)

An act is not a board letter.

1. Citations — legal basis (`Having regard to…`)
2. Recitals — reasons, numbered `(1)`, not operative
3. Enacting formula — `HAS ADOPTED THIS RESOLUTION:`
4. Articles — the obligations (`ARTICLE 1.` is accepted as `SECTION 1.`)

A recital that says `shall` is a warning. The obligation belongs in an article.

The approval route can be the Board path or the Commission path:
Drafting service → Inter-service consultation → Legal Service →
Impact assessment → College / Board adoption.

LEOS XML in `apps/` remains the rebuild. This is the form, in production.
