# Awareness (Legistar-style desk)

The chamber display is not part of this because you said not to touch it.

Legistar works because InSite and the Files module answer three questions
without opening a second window: what is waiting, what moved, what is next.
Those queries already existed. They were never asked together.

## Shipped

- `legacy/src/awareness.js` — desk snapshot, recent actions, moved-since-watch
- tests in `legacy/test/awareness.test.js`
- Watching marked when a file moved after you starred it
- Desk strip, file glance, recent-actions card wired in layout/pages/CSS

Item-level video timestamps already exist (`video_url` + `video_ts`).
Routing mail already exists (`notify.matterActivity`, daily digest).

## Actually not worth building

A Granicus MediaManager client. That is their encoder/cloud and their
contract. Link the video you already host.
