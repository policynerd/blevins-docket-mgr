'use strict';

// Notification plumbing: event helpers queue plain-text emails into
// mail_outbox; a background loop delivers them via the SMTP client with
// retries. Everything is a silent no-op until SMTP_* env vars are set, so the
// app runs identically without a mail relay. This module deliberately avoids
// requiring repo.js (repo calls into notify on some events).
const { db } = require('./db');
const smtp = require('./smtp');
const { ORG } = require('./org');

const MAX_ATTEMPTS = 5;

function baseUrl() {
  return String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
}

function link(path) {
  const b = baseUrl();
  return b ? b + path : path;
}

// Queue one message (no-op when SMTP isn't configured).
function queue(to, subject, body) {
  if (!smtp.isConfigured() || !to) return;
  db.prepare('INSERT INTO mail_outbox (to_email, subject, body) VALUES (?,?,?)')
    .run(to, `[${ORG.name}] ${subject}`, body + `\n\n—\n${ORG.name} · ${link('/')}`);
}

// --- Event helpers -------------------------------------------------------------

// An approval step is now waiting on its assignee.
function approvalRouted(stepId) {
  try {
    const s = db.prepare(`
      SELECT w.name AS step_name, w.seq, u.email, u.name AS user_name,
             m.file_number, m.title
      FROM workflow_steps w
      JOIN users u ON u.id = w.assignee_id
      JOIN matters m ON m.id = w.matter_id
      WHERE w.id = ?`).get(stepId);
    if (!s || !s.email) return;
    queue(s.email, `Approval waiting: ${s.file_number}`,
      `${s.user_name},\n\nStep ${s.seq} (${s.step_name}) of file ${s.file_number} — "${s.title}" — is routed to you.\n\n`
      + `Review it in your approvals inbox: ${link('/approvals')}`);
  } catch (e) { console.error('notify.approvalRouted failed:', e.message); }
}

// Activity on a file: tell everyone watching it.
function matterActivity(matterId, actionText) {
  try {
    if (!smtp.isConfigured()) return;
    const m = db.prepare('SELECT file_number, title FROM matters WHERE id = ?').get(matterId);
    if (!m) return;
    const watchers = db.prepare(`
      SELECT DISTINCT u.email FROM watches w
      JOIN users u ON u.id = w.user_id
      WHERE w.matter_id = ? AND u.active = 1 AND u.email IS NOT NULL`).all(matterId);
    for (const w of watchers) {
      queue(w.email, `${m.file_number}: ${actionText}`,
        `Activity on ${m.file_number} — "${m.title}":\n\n  ${actionText}\n\n`
        + `View the file: ${link('/legislation/' + encodeURIComponent(m.file_number))}`);
    }
  } catch (e) { console.error('notify.matterActivity failed:', e.message); }
}

// Board/commission application decided.
function applicationDecision(appId) {
  try {
    const a = db.prepare(`SELECT a.*, b.name AS body_name FROM board_applications a
      JOIN bodies b ON b.id = a.body_id WHERE a.id = ?`).get(appId);
    if (!a || !a.email) return;
    const msg = a.status === 'Nominated'
      ? `Good news — your application to serve on the ${a.body_name} has been advanced: you have been `
        + 'nominated through the membership process. The Clerk\'s office will contact you about next steps.'
      : `Thank you for applying to serve on the ${a.body_name}. The application was not advanced at this time.`;
    queue(a.email, `Your application to the ${a.body_name}`, `${a.name},\n\n${msg}`);
  } catch (e) { console.error('notify.applicationDecision failed:', e.message); }
}

// Request to speak approved.
function speakerApproved(speakerId) {
  try {
    const s = db.prepare(`
      SELECT s.*, mt.meeting_date, mt.meeting_time, mt.location, b.name AS body_name
      FROM speaker_requests s
      JOIN meetings mt ON mt.id = s.meeting_id
      JOIN bodies b ON b.id = mt.body_id
      WHERE s.id = ?`).get(speakerId);
    if (!s || !s.email) return;
    queue(s.email, `You're confirmed to speak — ${s.meeting_date}`,
      `${s.name},\n\nYour request to speak at the ${s.body_name} meeting on ${s.meeting_date}`
      + `${s.meeting_time ? ' at ' + s.meeting_time : ''}${s.location ? ' (' + s.location + ')' : ''} is confirmed.\n\n`
      + `Meeting details: ${link('/meetings/' + s.meeting_id)}`);
  } catch (e) { console.error('notify.speakerApproved failed:', e.message); }
}

// Citizen proposal decided (accepted → introduced, or declined).
function proposalDecision(proposalId) {
  try {
    const p = db.prepare('SELECT p.*, m.file_number FROM proposals p LEFT JOIN matters m ON m.id = p.matter_id WHERE p.id = ?').get(proposalId);
    if (!p || !p.email) return;
    const msg = p.status === 'Accepted'
      ? `Your proposal "${p.title}" has been accepted and introduced as a legislative file`
        + `${p.file_number ? ' (' + p.file_number + ')' : ''}. Thank you for participating.`
      : `Thank you for your proposal "${p.title}". It was not advanced at this time.`;
    queue(p.email, `Your proposal: ${p.title}`, `${p.name},\n\n${msg}`);
  } catch (e) { console.error('notify.proposalDecision failed:', e.message); }
}

// Solicitation awarded — notify the winning vendor.
function procurementAward(solicitationId) {
  try {
    const s = db.prepare(`SELECT s.number, s.title, s.award_amount, v.name AS vendor_name, v.email
      FROM solicitations s JOIN vendors v ON v.id = s.awarded_vendor_id
      WHERE s.id = ?`).get(solicitationId);
    if (!s || !s.email) return;
    const amount = s.award_amount != null
      ? ' in the amount of $' + Number(s.award_amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : '';
    queue(s.email, `Award notice: ${s.number}`,
      `${s.vendor_name},\n\nYour firm has been selected for solicitation ${s.number} — "${s.title}"${amount}.\n\n`
      + `The Clerk's office will follow up regarding the contract.\n\nDetails: ${link('/procurement/' + solicitationId)}`);
  } catch (e) { console.error('notify.procurementAward failed:', e.message); }
}

// --- Delivery loop ---------------------------------------------------------------
let sending = false;

async function processOutbox() {
  if (sending || !smtp.isConfigured()) return;
  sending = true;
  try {
    const pending = db.prepare(`SELECT * FROM mail_outbox
      WHERE status = 'Pending' AND attempts < ? ORDER BY id LIMIT 10`).all(MAX_ATTEMPTS);
    for (const m of pending) {
      try {
        await smtp.sendMail({ to: m.to_email, subject: m.subject, text: m.body });
        db.prepare(`UPDATE mail_outbox SET status='Sent', sent_at=datetime('now'),
          attempts=attempts+1 WHERE id=?`).run(m.id);
      } catch (e) {
        const attempts = m.attempts + 1;
        db.prepare(`UPDATE mail_outbox SET attempts=?, last_error=?, status=? WHERE id=?`)
          .run(attempts, String(e.message).slice(0, 400),
            attempts >= MAX_ATTEMPTS ? 'Failed' : 'Pending', m.id);
      }
    }
  } finally {
    sending = false;
  }
}

function schedule() {
  if (!smtp.isConfigured()) return;
  processOutbox().catch(() => {});
  setInterval(() => processOutbox().catch(() => {}), 30 * 1000).unref();
}

function recent(limit = 50) {
  return db.prepare('SELECT * FROM mail_outbox ORDER BY id DESC LIMIT ?').all(limit);
}

module.exports = {
  queue, approvalRouted, matterActivity, applicationDecision, speakerApproved, proposalDecision,
  procurementAward, processOutbox, schedule, recent, baseUrl,
};
