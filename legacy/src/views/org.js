'use strict';

const { html, raw } = require('../util');
const { layout, card, emptyState, escapeText, brandMark } = require('./layout');
const { ORG } = require('../org');
const repo = require('../repo');

function levelBadge(level) {
  return `<span class="org-lvl org-lvl-${escapeText(String(level).toLowerCase())}">${escapeText(level)}</span>`;
}

function leaderLine(u) {
  const l = repo.org.leader(u);
  if (!l) return '<span class="muted">Leader: vacant</span>';
  const title = l.title ? ` <span class="muted">— ${escapeText(l.title)}</span>` : '';
  // Linked where the leader is a person of record, so the chart reaches the
  // rest of the system instead of repeating a name back at you.
  const who = l.id
    ? `<a href="/people/${l.id}">${escapeText(l.full_name)}</a>`
    : escapeText(l.full_name);
  return `<span class="org-leader">${who}${title}</span>`;
}

// --- Public directory (nested tree) -----------------------------------------
function nodeHtml(u) {
  const kids = u.children && u.children.length
    ? `<ul class="org-children">${u.children.map(nodeHtml).join('')}</ul>` : '';
  return `<li class="org-node">
    <div class="org-row">
      ${levelBadge(u.level)}
      <a class="org-name" href="/org/${u.id}">${escapeText(u.name)}</a>
      ${leaderLine(u)}
    </div>
    ${kids}
  </li>`;
}

function orgDirectory() {
  const tree = repo.org.tree();
  const counts = repo.org.counts();
  const stat = (n, l) => `<div class="stat"><span class="stat-n">${n}</span><span class="stat-l">${l}</span></div>`;
  const body = html`
    <div class="stat-grid small">
      ${raw(stat(counts.Division, 'Divisions'))}
      ${raw(stat(counts.Department, 'Departments'))}
      ${raw(stat(counts.Office, 'Offices'))}
      ${raw(stat(counts.Unit, 'Units'))}
    </div>
    ${raw(card('Organizational structure', tree.length
      ? `<ul class="org-tree">${tree.map(nodeHtml).join('')}</ul>`
      : emptyState('No organizational units defined yet.'),
      { actions: '<a class="btn-link" href="/admin/org">Manage</a>' }))}`;
  return layout({ title: 'Organization', active: '/org',
    subtitle: 'Divisions, departments, offices, and units — each with its leader.', body });
}

// --- Unit detail -------------------------------------------------------------
// A masthead lockup for an office, department, division or unit, built from
// the board's own mark rather than a separate asset per unit: the seal, a
// rule, the parent organization in small caps, then the unit's own name.
//
// It is set on the navy band so reversed artwork reads correctly, and so a
// sub-unit inherits the institution's authority instead of appearing to be a
// separate brand — the same relationship a government department's mark has to
// the department above it. The line above the name is the parent unit when
// there is one, so an office reads under its department.
function unitLockup(unit, ancestors = []) {
  const parent = ancestors.length ? ancestors[ancestors.length - 1].name : ORG.name;
  // brandMark() already returns markup; this is a plain template string, not an
  // html`` one, so wrapping it in raw() would stringify as [object Object].
  return `<div class="unit-lockup">
    ${brandMark()}
    <span class="ul-rule" aria-hidden="true"></span>
    <span class="ul-text">
      <small>${escapeText(parent)}</small>
      <strong>${escapeText(unit.name)}</strong>
      <em>${escapeText(unit.level)}</em>
    </span>
  </div>`;
}

function orgUnitDetail(unit) {
  const { money } = require('./budget');
  const ancestors = repo.org.ancestors(unit.id);
  const children = repo.org.children(unit.id);
  const leader = repo.org.leader(unit);
  const lines = repo.org.budgetLines(unit.id);
  const totals = repo.org.budgetTotals(unit.id);
  const matters = repo.org.matters(unit.id);

  const leaderCard = leader ? `
    <dl class="meta record-header">
      <dt>Leader</dt><dd>${leader.id
    ? `<a href="/people/${leader.id}">${escapeText(leader.full_name)}</a>`
    : escapeText(leader.full_name)}</dd>
      ${leader.title ? `<dt>Title</dt><dd>${escapeText(leader.title)}</dd>` : ''}
      ${leader.email ? `<dt>Email</dt><dd><a href="mailto:${escapeText(leader.email)}">${escapeText(leader.email)}</a></dd>` : ''}
      ${leader.phone ? `<dt>Phone</dt><dd>${escapeText(leader.phone)}</dd>` : ''}
    </dl>` : emptyState('Leadership position is currently vacant.');

  // What the unit is answerable for. This is the whole point of linking the
  // chart to the rest of the record: a department page that cannot say what it
  // spends or what it has before the Board is a name in a list.
  const remaining = totals.expense - totals.spent;
  const budgetCard = (lines.length || totals.expense || totals.revenue) ? `
    <div class="stat-grid small">
      <div class="stat"><span class="stat-n">${money(totals.expense)}</span><span class="stat-l">Appropriated</span></div>
      <div class="stat"><span class="stat-n">${money(totals.spent)}</span><span class="stat-l">Spent</span></div>
      <div class="stat${remaining < 0 ? ' stat-flag' : ''}"><span class="stat-n">${money(remaining)}</span><span class="stat-l">Remaining</span></div>
      ${totals.revenue ? `<div class="stat"><span class="stat-n">${money(totals.revenue)}</span><span class="stat-l">Revenue</span></div>` : ''}
    </div>
    ${lines.length ? `<table class="data"><thead><tr><th>FY</th><th>Appropriation</th><th>Code</th>
      <th class="num">Amount</th></tr></thead><tbody>${lines.map((l) => `
      <tr>
        <td>${escapeText(l.fiscal_year)}</td>
        <td><a href="/budget/${l.budget_id}">${escapeText(l.name)}</a></td>
        <td class="muted">${escapeText(l.appropriation_code || '—')}</td>
        <td class="num">${money(l.amount)}</td>
      </tr>`).join('')}</tbody></table>` : ''}`
    : emptyState('No appropriation is held by this unit.');

  const mattersCard = matters.length
    ? `<table class="data"><thead><tr><th>File #</th><th>Title</th><th>Type</th><th>Status</th></tr></thead>
       <tbody>${matters.map((m) => `
        <tr>
          <td><a href="/legislation/${encodeURIComponent(m.file_number)}">${escapeText(m.file_number)}</a></td>
          <td class="title-cell">${escapeText(m.title)}</td>
          <td>${escapeText(m.type)}</td>
          <td>${escapeText(m.status)}</td>
        </tr>`).join('')}</tbody></table>`
    : emptyState('This unit has brought nothing before the Board.');

  const childRows = children.length
    ? `<ul class="org-tree">${children.map((c) => `<li class="org-node"><div class="org-row">${levelBadge(c.level)}<a class="org-name" href="/org/${c.id}">${escapeText(c.name)}</a>${leaderLine(c)}</div></li>`).join('')}</ul>`
    : emptyState('No sub-units.');

  const body = html`
    ${raw(unitLockup(unit, ancestors))}
    ${raw(card('Budget', budgetCard, {
    actions: `<a class="btn-link" href="/budget">All budgets →</a>`,
  }))}
    ${raw(card('Before the Board', mattersCard))}
    ${raw(card('Leadership', leaderCard))}
    ${unit.description ? raw(card('About', `<p>${escapeText(unit.description)}</p>`)) : ''}
    ${raw(card('Sub-units', childRows))}`;

  return layout({
    title: unit.name,
    subtitle: unit.level,
    crumbs: [{ href: '/org', label: 'Organization' }]
      .concat(ancestors.map((a) => ({ href: `/org/${a.id}`, label: a.name })))
      .concat([{ label: unit.name }]),
    actions: `<a class="btn" href="/admin/org/${unit.id}/edit">Manage this ${escapeText(unit.level.toLowerCase())}</a>`,
    active: '/org',
    body,
  });
}

// --- Admin: manage tree ------------------------------------------------------
function adminNode(u) {
  const kids = u.children && u.children.length
    ? `<ul class="org-children">${u.children.map(adminNode).join('')}</ul>` : '';
  const childLevel = nextLevel(u.level);
  const addChild = childLevel
    ? `<a class="btn-link" href="/admin/org/new?parent=${u.id}&level=${encodeURIComponent(childLevel)}">+ ${escapeText(childLevel)}</a>` : '';
  return `<li class="org-node">
    <div class="org-row">
      ${levelBadge(u.level)}
      <span class="org-name">${escapeText(u.name)}</span>
      ${leaderLine(u)}
      <span class="org-admin-actions">
        <a class="btn-link" href="/admin/org/${u.id}/edit">Edit</a>
        ${addChild}
        <form method="post" action="/admin/org/${u.id}/delete" class="inline-del" onsubmit="return confirm('Delete this unit and all its sub-units?')"><button type="submit" class="link-danger">Delete</button></form>
      </span>
    </div>
    ${kids}
  </li>`;
}

function nextLevel(level) {
  const i = repo.ORG_LEVELS.indexOf(level);
  return i >= 0 && i < repo.ORG_LEVELS.length - 1 ? repo.ORG_LEVELS[i + 1] : null;
}

function orgAdmin() {
  const tree = repo.org.tree();
  const body = html`
    <div class="admin-actions">
      <a class="btn" href="/admin/org/new?level=Division">+ New division</a>
      <a class="btn-link" href="/org">View public directory</a>
    </div>
    ${raw(card('Manage organization', tree.length
      ? `<ul class="org-tree admin">${tree.map(adminNode).join('')}</ul>`
      : emptyState('No units yet — add your first division.')))}
    ${raw(card('Import units & leaders', `
      <p class="muted">Bulk-load the org chart and its leaders. Columns:
        <code>level,name,parent,leader_name,leader_title,leader_email,leader_phone,description</code>.
        Level is one of ${repo.ORG_LEVELS.join(' / ')}; <code>parent</code> is another unit's name
        (list parents before their children). Importing adds units — it never deletes existing ones.</p>
      <form class="form" method="post" action="/admin/org/import">
        <label>Org chart CSV<textarea name="csv" rows="6" placeholder="Division,Office of the Executive,,Jane Roe,Executive Director,jroe@example.gov,,
Department,Finance,Office of the Executive,John Doe,Finance Director,jdoe@example.gov,,"></textarea></label>
        <button type="submit" class="btn primary">Import units</button>
      </form>`))}`;
  return layout({ title: 'Manage organization', active: '/admin',
    subtitle: 'Build the org chart down to each unit and its leader.', body });
}

// --- Admin: create / edit form ----------------------------------------------
function orgForm(unit, opts = {}) {
  const isEdit = !!unit;
  const level = unit ? unit.level : (opts.level || 'Division');
  const parentId = unit ? unit.parent_id : (opts.parentId || '');
  const action = isEdit ? `/admin/org/${unit.id}` : '/admin/org';

  const levelOpts = repo.ORG_LEVELS.map((l) =>
    `<option value="${l}"${l === level ? ' selected' : ''}>${l}</option>`).join('');
  const parentOpts = '<option value="">— none (top level) —</option>' + repo.org.all()
    .filter((u) => !unit || u.id !== unit.id)
    .map((u) => `<option value="${u.id}"${String(u.id) === String(parentId) ? ' selected' : ''}>${escapeText(u.level + ': ' + u.name)}</option>`).join('');
  const leaderId = unit ? unit.leader_person_id : null;
  const personOpts = '<option value="">— not linked to a person of record —</option>'
    + repo.people.all().map((p) => `<option value="${p.id}"`
      + `${String(p.id) === String(leaderId) ? ' selected' : ''}>`
      + `${escapeText(p.full_name)}${p.title ? ' — ' + escapeText(p.title) : ''}</option>`).join('');

  const form = html`
    <form class="form" method="post" action="${action}">
      <div class="form-row">
        <label>Level<select name="level" required>${raw(levelOpts)}</select></label>
        <label>Reports to (parent)<select name="parent_id">${raw(parentOpts)}</select></label>
      </div>
      <label>Name<input type="text" name="name" required value="${unit ? unit.name : ''}" placeholder="e.g. Department of Public Works"></label>
      <fieldset>
        <legend>Leader</legend>
        <label>Person of record
          <select name="leader_person_id">${raw(personOpts)}</select>
          <small class="muted">Linking a person connects this unit to their profile, their
            seats and their voting record. Use the fields below only for a leader who is not
            in the roster.</small>
        </label>
        <div class="form-row">
          <label>Name (if not in the roster)<input type="text" name="leader_name" value="${unit ? (unit.leader_name || '') : ''}" placeholder="Individual leader"></label>
          <label>Title<input type="text" name="leader_title" value="${unit ? (unit.leader_title || '') : ''}" placeholder="e.g. Director"></label>
        </div>
        <div class="form-row">
          <label>Email<input type="email" name="leader_email" value="${unit ? (unit.leader_email || '') : ''}"></label>
          <label>Phone<input type="text" name="leader_phone" value="${unit ? (unit.leader_phone || '') : ''}"></label>
        </div>
      </fieldset>
      <label>Description<textarea name="description" rows="3">${unit ? escapeText(unit.description || '') : ''}</textarea></label>
      <label>Sort order<input type="text" name="sort_order" value="${unit ? unit.sort_order : '0'}"></label>
      <div class="form-actions">
        <button type="submit" class="btn primary">${isEdit ? 'Save unit' : 'Create unit'}</button>
        <a class="btn-link" href="/admin/org">Cancel</a>
        ${isEdit ? raw(`<a class="btn-link" href="/org/${unit.id}">View</a>`) : ''}
      </div>
    </form>`;
  const body = html`${raw(card(isEdit ? 'Unit details' : 'Create unit', form))}`;
  return layout({
    title: isEdit ? `Edit ${unit.name}` : 'New organizational unit',
    subtitle: isEdit ? unit.level : 'A division, department, office or unit of the organization.',
    crumbs: [
      { href: '/admin/org', label: 'Manage organization' },
      { label: isEdit ? unit.name : 'New unit' },
    ],
    active: '/admin',
    body,
  });
}

module.exports = { orgDirectory, orgUnitDetail, orgAdmin, orgForm };
