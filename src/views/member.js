'use strict';

const { html, raw, formatDate, formatDateTime, todayISO } = require('../util');
const { layout, card, statusBadge, typeBadge, emptyState } = require('./layout');
const repo = require('../repo');

function memberHome(user) {
  const person = user.person_id ? repo.people.get(user.person_id) : null;
  const memberships = person ? repo.people.memberships(person.id) : [];
  const sponsored = person ? repo.people.sponsored(person.id) : [];
  const voteRecord = person ? repo.votes.byPerson(person.id) : [];
  const summary = person ? repo.votes.personSummary(person.id) : { total: 0 };

  // Upcoming meetings for the member's bodies.
  const bodyIds = new Set(memberships.map((m) => m.body_id));
  const today = todayISO();
  const upcoming = repo.meetings.upcoming(today, 30).filter((m) => bodyIds.has(m.body_id));
  const liveNow = repo.meetings.all().find((m) => m.status === 'In Progress' && bodyIds.has(m.body_id));

  const stat = (n, l) => `<div class="stat"><span class="stat-n">${n}</span><span class="stat-l">${l}</span></div>`;

  const liveBanner = liveNow
    ? `<a class="live-banner" href="/live/${liveNow.id}">● A meeting of the ${escapeText(liveNow.body_name)} is LIVE now — join to vote →</a>`
    : '';

  const memRows = memberships.length
    ? `<ul class="plain">${memberships.map((m) => html`<li><a href="/bodies/${m.body_id}">${m.body_name}</a> — ${m.role}${m.voting ? '' : ' (non-voting)'}</li>`).join('')}</ul>`
    : emptyState('No committee memberships on record.');

  const sponsoredRows = sponsored.length ? sponsored.slice(0, 12).map((m) => html`
    <tr>
      <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
      <td>${typeBadge(m.type)}</td>
      <td class="title-cell">${m.title}</td>
      <td>${statusBadge(m.status)}</td>
    </tr>`).join('') : null;

  const upcomingRows = upcoming.length ? upcoming.map((m) => html`
    <tr>
      <td>${raw(formatDateTime(m.meeting_date, m.meeting_time))}</td>
      <td><a href="/meetings/${m.id}">${m.body_name}</a></td>
      <td><a href="/meetings/${m.id}/packet">Packet</a> · <a href="/live/${m.id}">Live</a></td>
    </tr>`).join('') : null;

  const voteRows = voteRecord.length ? voteRecord.slice(0, 12).map((r) => html`
    <tr>
      <td>${raw(formatDate(r.meeting_date))}</td>
      <td class="title-cell">${r.file_number
        ? raw(html`<a href="/legislation/${encodeURIComponent(r.file_number)}">${r.file_number}</a> — ${r.matter_title}`)
        : (r.item_action || '')}</td>
      <td>${raw(`<span class="vt vt-${String(r.vote).toLowerCase()}">${escapeText(r.vote)}</span>`)}</td>
    </tr>`).join('') : null;

  const body = html`
    ${raw(liveBanner)}
    <div class="page-head">
      <h1>Welcome, ${person ? person.full_name : user.name}</h1>
      <p class="muted">Your board member workspace — agendas, sponsored legislation, and your voting record.</p>
    </div>
    <div class="admin-actions">
      <a class="btn primary" href="/member/files/new">✎ Draft a new file</a>
      ${liveNow ? raw(`<a class="btn" href="/live/${liveNow.id}">● Join live meeting</a>`) : ''}
    </div>
    <div class="stat-grid small">
      ${raw(stat(memberships.length, 'Memberships'))}
      ${raw(stat(sponsored.length, 'Sponsored files'))}
      ${raw(stat(summary.total, 'Votes cast'))}
      ${raw(stat(upcoming.length, 'Upcoming meetings'))}
    </div>
    <div class="grid-2">
      ${raw(card('Upcoming meetings', upcomingRows
        ? `<table class="data"><thead><tr><th>When</th><th>Body</th><th>Documents</th></tr></thead><tbody>${upcomingRows}</tbody></table>`
        : emptyState('No upcoming meetings for your bodies.')))}
      ${raw(card('Your memberships', memRows))}
    </div>
    ${raw(card('Your sponsored legislation', sponsoredRows
      ? `<table class="data"><thead><tr><th>File #</th><th>Type</th><th>Title</th><th>Status</th></tr></thead><tbody>${sponsoredRows}</tbody></table>`
      : emptyState('You have not sponsored any legislation yet.')))}
    ${raw(card('Your recent votes', voteRows
      ? `<table class="data"><thead><tr><th>Date</th><th>Item</th><th>Vote</th></tr></thead><tbody>${voteRows}</tbody></table>`
      : emptyState('No recorded votes yet.')))}`;
  return layout({ title: 'Member Portal', active: '/member', body });
}

function memberFileForm(user) {
  const { editorField } = require('./reports');
  const docTemplates = require('../doc-templates');
  const typeOptions = repo.MATTER_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('');
  // Pre-fill the editor with the form template for the initially selected
  // type; a small script swaps templates on type change while the draft is
  // still untouched (JSON is </-escaped so it can't close the script tag).
  const templates = {};
  for (const t of repo.MATTER_TYPES) templates[t] = docTemplates.applyTemplate(t, {}) || '';
  const templatesJson = JSON.stringify(templates).replace(/</g, '\\u003c');
  const firstTemplate = templates[repo.MATTER_TYPES[0]] || '';
  const form = html`
    <form class="form" method="post" action="/member/files" data-wp-form>
      <div class="form-row">
        <label>Type<select name="type" required>${raw(typeOptions)}</select></label>
        <label>Title<input type="text" name="title" required placeholder="An ordinance / resolution to…"></label>
      </div>
      <label>Summary<textarea name="summary" rows="3" placeholder="Plain-language summary for the record…"></textarea></label>
      ${raw(editorField('body_html', firstTemplate, { label: 'Draft legislative text', rows: 14 }))}
      <div class="form-actions">
        <button type="submit" class="btn primary">Submit draft</button>
        <a class="btn-link" href="/member">Cancel</a>
      </div>
      <p class="muted">The editor starts from the form template for the selected type — replace the blanks
        and boilerplate with your draft. Your draft is filed as <strong>Draft</strong> with you as primary
        sponsor, then routed to the Clerk for introduction.</p>
    </form>
    <script src="/assets/editor.js" defer></script>
    <script>
      (function(){
        var templates = ${raw(templatesJson)};
        var sel = document.querySelector('select[name="type"]');
        var area = document.querySelector('[data-wp-editor]');
        var out = document.querySelector('[data-wp-output]');
        if (!sel || !area || !out) return;
        function isUntouched(){
          var cur = area.innerHTML.trim();
          if (!cur) return true;
          return Object.keys(templates).some(function(t){ return templates[t].trim() === cur; });
        }
        sel.addEventListener('change', function(){
          if (!isUntouched()) return; // never clobber real drafting
          area.innerHTML = templates[sel.value] || '';
          out.value = area.innerHTML;
        });
      })();
    </script>`;
  const body = html`
    <p class="crumbs"><a href="/member">Member Portal</a> / Draft a new file</p>
    <h1>Draft a new legislative file</h1>
    ${raw(card('Word processor', form))}`;
  return layout({ title: 'Draft a new file', active: '/member', body });
}

// Watched files with their latest recorded action (any signed-in user).
function watchingPage(user) {
  const rows = repo.watches.forUser(user.id);
  const table = rows.length
    ? `<table class="data"><thead><tr><th>File #</th><th>Title</th><th>Status</th><th>Latest action</th><th></th></tr></thead><tbody>${
      rows.map((m) => html`
        <tr>
          <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${m.file_number}</a></td>
          <td class="title-cell">${m.title}</td>
          <td>${statusBadge(m.status)}</td>
          <td>${m.last_action ? raw(`${escapeText(m.last_action)} <span class="muted">· ${escapeText(formatDate(m.last_action_date))}</span>`) : raw('<span class="muted">—</span>')}</td>
          <td>
            <form method="post" action="/legislation/${encodeURIComponent(m.file_number)}/watch" class="inline">
              <button type="submit" class="btn-link">Unwatch</button>
            </form>
          </td>
        </tr>`).join('')}</tbody></table>`
    : emptyState('You are not watching any files yet. Use the ☆ Watch button on any legislative file.');
  const body = html`
    <h1>Watching</h1>
    <p class="muted">Files you follow, with their most recent recorded action. Each file also has an
      RSS activity feed you can subscribe to from its page.</p>
    ${raw(card(`Watched files (${rows.length})`, table))}`;
  return layout({ title: 'Watching', active: '/watching', body });
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { memberHome, memberFileForm, watchingPage };
