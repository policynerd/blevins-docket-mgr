'use strict';

// Who may read what.
//
// The whole of this system's authorization used to be three path prefixes
// (`AREA_ROLES` in http/kernel.js): /admin wants a clerk, /govern wants staff,
// /member wants a member, and everything else was public. That is a fine rule
// for *areas* and no rule at all for *records* — so a board letter was at a
// public URL from the moment its empty template was inserted, a draft agenda
// was readable from the first keystroke, and the minutes view printed the
// words "Draft Minutes" at the top of a page it served to anyone who asked.
//
// This module is the missing half: per-record visibility, written as four
// predicates in one file so the rule can be read at a glance and tested
// directly, rather than as a condition remembered at each of a dozen routes.
//
// The threshold is `member`. ROLE_RANK is public:0, member:1, staff:2,
// clerk:3, admin:4, so anyone holding a seat sees exactly what they saw
// before; a signed-out visitor, and a signed-in account with role `public`
// (which is what vendor registration creates), sees only what a clerk has
// deliberately published.
//
// Always ask `auth.hasRole`, never compare `user.role` to a string. Ranks are
// the point: the live board once tested `role === 'member'` and thereby hid
// the vote buttons from the Chair, who is seeded as staff.

const auth = require('./auth');

// Anyone inside the organization. Not a claim about *which* records they may
// see — every internal role sees drafts — only that they are not the public.
function isInsider(user) {
  return auth.hasRole(user, 'member');
}

function canSeeMatter(user, m) {
  if (!m) return false;
  return isInsider(user) || !!m.published_at;
}

function canSeeAgenda(user, mt) {
  if (!mt) return false;
  return isInsider(user) || !!mt.agenda_published_at;
}

// Minutes already had a publication state — 'none' | 'draft' | 'published' —
// and nothing consulted it. The column is not new; honouring it is.
function canSeeMinutes(user, mt) {
  if (!mt) return false;
  return isInsider(user) || mt.minutes_status === 'published';
}

function canSeeReport(user, r) {
  if (!r) return false;
  return isInsider(user) || !!r.published_at;
}

module.exports = {
  isInsider,
  canSeeMatter,
  canSeeAgenda,
  canSeeMinutes,
  canSeeReport,
};
