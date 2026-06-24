'use strict';

// Central organization identity / branding.
//
// Every label that used to be hard-coded to the demo municipality lives here so
// a deployment can be rebranded entirely from the environment — no code edits.
// Defaults describe a Board of Governors (this instance) rather than the old
// "City of Westbrook" demo. Override any value with the matching ORG_* env var.
const ORG = {
  // Top-line identity shown in the utility bar, banner, footer, and <title>.
  name: process.env.ORG_NAME || 'Board of Governors',
  tagline: process.env.ORG_TAGLINE || 'Legislative Information Center',
  // Decorative seal/emblem glyph next to the name (user supplies a real logo).
  seal: process.env.ORG_SEAL || '★',

  // The primary legislative body and the roles within it.
  primaryBody: process.env.ORG_PRIMARY_BODY || 'Board of Governors',
  primaryBodyType: process.env.ORG_PRIMARY_BODY_TYPE || 'Governing Board',
  // Plural label for the elected/appointed officials (nav + listing pages).
  membersLabel: process.env.ORG_MEMBERS_LABEL || 'Board Members',
  // Singular titles used in seed data and role mapping.
  chairTitle: process.env.ORG_CHAIR_TITLE || 'Chair',
  viceChairTitle: process.env.ORG_VICE_CHAIR_TITLE || 'Vice Chair',
  memberTitle: process.env.ORG_MEMBER_TITLE || 'Governor',
  clerkTitle: process.env.ORG_CLERK_TITLE || 'Clerk of the Board',
  clerkOffice: process.env.ORG_CLERK_OFFICE || 'Office of the Clerk of the Board',

  // Where meetings convene, and the email domain for official accounts.
  meetingLocation: process.env.ORG_MEETING_LOCATION || 'Boardroom',
  emailDomain: process.env.ORG_EMAIL_DOMAIN || 'board.gov',
};

// Build an official email address from a local-part (e.g. 'clerk' -> clerk@domain).
function orgEmail(localPart) {
  return `${localPart}@${ORG.emailDomain}`;
}

module.exports = { ORG, orgEmail };
