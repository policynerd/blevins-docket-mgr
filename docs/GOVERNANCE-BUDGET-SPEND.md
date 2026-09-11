# Three books, one record

The chamber display is not part of this. It shows a published meeting.
These are the books a clerk of Blevins Holdings actually keeps.

## 1. Governance

Legislation, bodies, membership (Nominate → Approve → Seat), agendas,
votes, minutes. A measure is introduced, referred, heard, and disposed.
The vote ledger is append-only. That book does not spend money. It
*authorizes*.

## 2. Budget

A fiscal year, adopted line by line. The adopted amount is never
overwritten; a later change is an amendment, preferably tied to the
file that authorized it. Legislation may commit a line through
`fiscal_impact`. TAS codes and appropriation rollups already exist.

## 3. Spend and expense

A request to use an appropriation. Staff file it. A *different* clerk
approves or denies it. Posting writes a `budget_transactions` row, which
is what the budget dashboard already calls "actuals".

```
Draft → Submitted → Approved → Posted
                   ↘ Denied
          Voided (before post only)
```

Imported actuals can still be typed straight onto a line. A request is
what you use when the spend has to answer "who asked, who allowed, which
account."

Holdings-scale still missing, and not pretended here: multi-entity
ledgers, AP integration, card feed, encumbrance accounting that survives
a fiscal-year close. Those attach to this request object rather than to
a new pile of transaction types.
