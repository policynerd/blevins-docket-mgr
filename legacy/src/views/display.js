'use strict';

// The chamber display.
//
// The board on the wall. It is not a page anyone navigates: it is read from
// across a room, by people who are not operating it, while a vote is being
// taken. That makes it a different medium from the rest of the application and
// it is built as one — no sidebar, no sign-in, no links, nothing clickable,
// and type large enough to read from the back row.
//
// Self-contained styles rather than /styles.css. This renders on whatever
// screen is bolted to the wall, and a display that inherits the application's
// responsive layout ends up showing a hamburger menu at 1920×1080. The board
// should also keep working if the stylesheet fails to load, which it will not
// do if its appearance depends on one.

const { escapeHtml, isBrandSrc } = require('../util');
const { sealSvg, dataUri } = require('../seal');
const lockupArt = require('../lockup');
const { ORG } = require('../org');

// The board's palette, as tokens.
//
// These were seventeen hex literals scattered through the stylesheet below,
// which meant the only way to answer "what colour is a Nay here?" was to read
// the whole thing, and the only way to change one was to find every place it
// appeared. Gathered here they can be read at a glance and overridden in one
// place — a deployment that needs the board to match a room's other signage
// redefines a token rather than editing layout rules.
//
// Deliberately NOT wired to the body accent that `brandHead()` emits as
// `--accent`. That colour identifies a body; these identify a vote. A board
// that rendered Nay in the Planning Commission's brand blue because the
// Planning Commission is sitting would be worse than one that ignored branding
// entirely — the room reads these as meaning, not as decoration.
//
// The vote colours keep their letters (see `chip` in display.js): the palette
// is overridable, so it cannot be the only thing carrying the vote.
const PALETTE = `
  :root {
    --ground: #000;
    --ink: #fff;
    --banner-bg: #1a1a1a;

    /* The four choices, and the two non-choices. */
    --vote-yea: #4caf25;
    --vote-nay: #cc0000;
    --vote-abstain: #17a5f2;
    --vote-recused: #d99b00;
    --vote-present: #5b6b7d;
    --vote-pending: #4a5561;

    /* Where the roll stands. --status-open is its own token rather than a
       reference to --vote-yea: they are the same green today, and a board that
       recoloured Yea should not thereby recolour "voting open". */
    --status-open: #4caf25;
    --status-closed: #ffd45e;
    --status-certified: #7fb0ff;
    --status-idle: #4a5561;
    --fail: #ff8a8a;

    /* Supporting type, in descending prominence. */
    --label: #7fb0ff;
    --attention: #ffd45e;
    --waiting: #dbe4ef;
    --motion: #c6d0dc;
    --dim: #b9c6d6;
    --faint: #93a1b1;
  }
`;

const STYLE = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body {
    margin: 0; height: 100%;
    background: var(--ground); color: var(--ink);
    font-family: "Helvetica Neue", Arial, "Liberation Sans", sans-serif;
    /* Tabular figures so the counts do not jitter as digits change. */
    font-variant-numeric: tabular-nums;
  }
  /* The seal behind everything — large, low-contrast, centred. It identifies
     the body without competing with the item for the room's attention. */
  body::before {
    content: ""; position: fixed; inset: 0;
    background: var(--seal) center center / auto 88vh no-repeat;
    opacity: .16; pointer-events: none;
  }
  .board {
    position: relative; height: 100%; display: flex; flex-direction: column;
    padding: 2.5vh 4vw; gap: 1.6vh;
  }

  /* Which body is sitting.
     The board carried no name at all: the room could see a roll being called
     and a result declared without being told whose. The title said so, but a
     browser tab is not visible on a screen bolted to a wall. Sized to be read
     on the way in and then ignored — it must not compete with the item. */
  .masthead { flex: 0 0 auto; opacity: .92; }
  .masthead svg { display: block; width: min(42vw, 620px); height: auto; }

  /* The result banner. Its own bar across the top, because the outcome is what
     the room is waiting for and it must not have to be read out of a tally. */
  .banner {
    background: var(--banner-bg); text-align: center;
    font-size: 8vh; font-weight: 800; line-height: 1.1;
    padding: 1.2vh 2vw; margin: -1vh -2vw 0;
  }
  .banner.passes { color: var(--ink); }
  .banner.fails  { color: var(--fail); }

  .label { font-size: 2.2vh; letter-spacing: .3em; text-transform: uppercase; color: var(--label); font-weight: 700; }
  .item-no { font-size: 2.6vh; letter-spacing: .2em; color: var(--dim); }
  /* Sized by fitText in display.js, which measures. These are the starting
     points it scales down from, and what the board falls back to if the script
     does not run. */
  h1 { margin: 0; font-size: 4.2vh; line-height: 1.2; font-weight: 700; }
  .motion { margin: 0; font-size: 2.6vh; color: var(--motion); line-height: 1.35; }
  .votes-needed { font-size: 2.6vh; letter-spacing: .16em; color: var(--attention); font-weight: 700; }

  .movers { display: grid; grid-template-columns: auto 1fr; gap: .4vh 2vw; font-size: 2.6vh; color: var(--dim); }
  .movers dt { color: var(--label); }
  .movers dd { margin: 0; font-weight: 600; color: var(--ink); }

  /* Counts as solid blocks. A number in a coloured box reads across a room in
     a way a coloured numeral does not. */
  .counts { display: flex; align-items: center; justify-content: center; gap: 2.4vw; font-size: 5.5vh; font-weight: 700; }
  .counts .n {
    display: inline-block; min-width: 2ch; text-align: center;
    padding: 0 .5vw; margin-left: 1vw; font-weight: 800; color: var(--ink);
  }
  .n.yea { background: var(--vote-yea); }
  .n.nay { background: var(--vote-nay); }
  .n.abstain { background: var(--vote-abstain); }
  .n.recused { background: var(--vote-recused); }

  /* The roll.
     A single flex column, which is right for a board of nine and wrong for
     anything much larger: seats simply ran off the bottom of the screen with
     nothing to catch them. A grid instead, with the column count set by the
     client from the size of the roll (see fitRoll in display.js) rather than
     by auto-fit — the constraint here is vertical space, and auto-fit
     responds to width, so on a 1920px screen it would spread nine seats into
     five sparse columns to solve a problem the board did not have. */
  .roll {
    flex: 1; display: grid; grid-auto-flow: column; align-content: center;
    grid-template-columns: 1fr; gap: .9vh 3vw;
  }
  .seat { display: flex; align-items: center; gap: 1.5vw; font-size: 4vh; line-height: 1.15; }
  /* In one column the chip belongs at the right margin: that is the roll-call
     board every chamber already reads, and with a single column there is
     nothing it could be mistaken for.

     In two or three it cannot stay there. A stretched name pushes the chip to
     its column's right edge, which puts it a few pixels from the *next*
     column's name and a third of the screen from its own — so the board reads
     as though every member had voted as the person to their left. The chip
     follows its name instead, and the name gives up its stretch.

     A name too long for its column is then truncated rather than allowed to
     wrap and push the roll out of vertical alignment. */
  .roll[data-cols="2"] .seat .name,
  .roll[data-cols="3"] .seat .name {
    flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .roll[data-cols="2"] .seat { font-size: 3.2vh; }
  .roll[data-cols="3"] .seat { font-size: 2.6vh; }
  .seat .name { flex: 1; }
  /* The chip carries a letter, so the vote is legible without relying on hue —
     a board read by people with any colour vision must not encode the vote in
     colour alone. */
  .chip {
    display: inline-block; min-width: 2.6ch; text-align: center;
    font-weight: 800; padding: 0 .4vw; color: var(--ink);
  }
  .chip.yea { background: var(--vote-yea); }
  .chip.nay { background: var(--vote-nay); }
  .chip.abstain { background: var(--vote-abstain); }
  .chip.present { background: var(--vote-present); }
  .chip.recused { background: var(--vote-recused); }
  .chip.pending { background: transparent; color: var(--vote-pending); }
  .mark { font-size: .38em; letter-spacing: .1em; color: var(--faint); margin-left: .8vw; }

  /* A ballot landing.
     Votes appeared instantly and silently, so a room watching the board had
     nothing to tell them a member had just voted as against having voted some
     time ago — the chip was simply green now. One short pulse marks the
     moment, on the chip that changed and no other.

     Honours prefers-reduced-motion. The board is bolted to a wall in a public
     room and cannot know who is in front of it, so the setting is the only
     signal available; the pulse is emphasis, never the only indication, and
     the chip's letter and colour carry the vote without it. */
  @keyframes vote-cast {
    0%   { transform: scale(1); }
    45%  { transform: scale(1.18); }
    100% { transform: scale(1); }
  }
  .chip.just-cast { animation: vote-cast 340ms ease-in-out; }
  @media (prefers-reduced-motion: reduce) {
    .chip.just-cast { animation: none; }
  }

  .status {
    text-align: center; font-size: 3.4vh; font-weight: 700;
    letter-spacing: .3em; text-transform: uppercase;
  }
  .open { color: var(--status-open); }
  .closed { color: var(--status-closed); }
  .certified { color: var(--status-certified); }
  .idle { color: var(--status-idle); }
  .basis { text-align: center; font-size: 2.2vh; color: var(--faint); letter-spacing: .05em; }
  .waiting {
    flex: 1; display: flex; align-items: center; justify-content: center;
    text-align: center; font-size: 5.5vh; color: var(--waiting); line-height: 1.3; font-weight: 600;
  }
  /* A board frozen on a live vote is worse than a dark one: it looks
     authoritative while being wrong. */
  .stale { position: fixed; inset: 0; background: rgba(0,0,0,.94);
    display: flex; align-items: center; justify-content: center;
    font-size: 4vh; color: var(--fail); letter-spacing: .1em; text-align: center; }
  [hidden] { display: none !important; }
`;

/**
 * Which body is sitting — when that needs saying.
 *
 * Only for a body below the Board. When the Board sits as itself the lockup
 * has nothing to add: the seal behind the board is the Board's, the room is
 * the Board's chamber, and a line reading BOARD OF GOVERNORS over a board that
 * is already the Board of Governors is furniture. The masthead exists to
 * answer "which of them is this?", and in plenary there is nothing to answer.
 *
 * A committee is the case it was built for — the Planning Commission and the
 * Committee on Appropriations meet in the same room, on the same screen, and
 * look identical without it.
 */
function masthead(body, meeting) {
  const named = lockupArt.subordinateName(body || { name: meeting.body_name });
  if (!named) return '';
  return `<div class="masthead">${lockupArt.horizontalSvg(
    body || { name: meeting.body_name }, { width: 620, ground: 'dark' },
  )}</div>`;
}

function displayBoard(meeting, body) {
  // The Board's own seal when one has been supplied, otherwise the drawn one.
  //
  // The reversed artwork, not the black: this board is white on black, and a
  // dark seal on a dark ground is a smudge. `logoLightUrl` is exactly the
  // setting that exists for that, already used by the navy sidebar.
  //
  // The generated seal is inlined as a data URI so the board makes no second
  // request; a supplied file is referenced by URL, because inlining a PNG of
  // any real size into every render would cost more than the request saves.
  // The same test the rest of the application applies to branding, rather than
  // this view's own. Rejecting a bare `"` kept the CSS string from being closed,
  // but a value carrying a newline ends it just as well, and a merely malformed
  // one — a typo in the Branding screen — put a broken background on the wall
  // instead of falling back to the drawn seal. isBrandSrc admits neither.
  const supplied = ORG.logoLightUrl || '';
  const seal = isBrandSrc(supplied)
    ? supplied
    : dataUri(sealSvg({ size: 512, ground: 'dark' }));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meeting.body_name)} — Chamber Display</title>
<style>${PALETTE}:root { --seal: url("${seal}"); }${STYLE}</style>
</head>
<body>
<div class="board" data-meeting="${meeting.id}">
  ${masthead(body, meeting)}
  <div class="banner" data-banner hidden></div>
  <div data-board hidden>
    <div class="label">Agenda Item</div>
    <div class="item-no" data-item-no></div>
    <h1 data-title></h1>
    <p class="motion" data-motion></p>
    <div class="votes-needed" data-votes-needed></div>
  </div>
  <div class="roll" data-roll></div>
  <div class="counts" data-counts hidden></div>
  <dl class="movers" data-movers hidden>
    <dt>Moved by</dt><dd data-mover></dd>
    <dt>Seconded by</dt><dd data-seconder></dd>
  </dl>
  <div class="basis" data-basis></div>
  <div class="status idle" data-status>Awaiting the chair</div>
</div>
<div class="stale" data-stale hidden>CONNECTION LOST — THIS BOARD MAY BE OUT OF DATE</div>
<script src="/assets/display.js" defer></script>
</body>
</html>`;
}

module.exports = { displayBoard };
