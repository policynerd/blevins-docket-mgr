# Awareness (Legistar-style desk)

The chamber display is not part of this.

Legistar works because InSite and the Files module answer three questions
without opening a second window: what is waiting, what moved, what is next.
Those queries already existed. They were never asked together.

## Shipped in code (`legacy/src/awareness.js`)

- Recent actions across published files
- Watch list with “moved since you watched”
- Desk snapshot for a signed-in user (inbox + watches + recent)

## Wire into the chrome (do not touch display.js / live.js)

1. `layout-base.js` — add Watching under Docket. After `announcementBanner()`,
   render a `.desk-strip` for signed-in users: Queue (clerks only),
   Watches + moved count, latest action file.
2. `pages.js` dashboard — card “Recent actions” from `awareness.recentActions`.
3. `pages.js` matterDetail — `.file-glance` above the Record card:
   last action, next hearing, in control, status.
4. `member.js` watchingPage — mark rows `movedSinceWatch`.
5. `institutional.css` — `.desk-strip`, `.desk-moved`, `.file-glance`.
   Hide `.desk-strip` in print.

Still not Granicus: no video timestamps, no MediaManager sync, no ATS
email storm. Those are products. This is the desk.
