'use strict';

const { html, raw } = require('../util');
const { layout, card, emptyState, escapeText } = require('./layout');
const repo = require('../repo');

function levelBadge(level) {
  return `<span class="org-lvl org-lvl-${escapeText(String(level).toLowerCase())}">${escapeText(level)}</span>`;
}

function leaderLine(u) {
  if (!u.leader_name) return '<span class="muted">Leader: vacant</span>';
  const title = u.leader_title ? ` <span class="muted">— ${escapeText(u.leader_title)}</span>` : '';
  return `<span class="org-leader">👤 ${escapeText(u.leader_name)}${title}</span>`;
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
function orgUnitDetail(unit) {
  const ancestors = repo.org.ancestors(unit.id);
  const children = repo.org.children(unit.id);
  const crumbs = [`<a href="/org">Organization</a>`]
    .concat(ancestors.map((a) => `<a href="/org/${a.id}">${escapeText(a.name)}</a>`))
    .concat([escapeText(unit.name)]).join(' / ');

  const leaderCard = unit.leader_name ? `
    <dl class="meta record-header">
      <dt>Leader</dt><dd>${escapeText(unit.leader_name)}</dd>
      ${unit.leader_title ? `<dt>Title</dt><dd>${escapeText(unit.leader_title)}</dd>` : ''}
      ${unit.leader_email ? `<dt>Email</dt><dd><a href="mailto:${escapeText(unit.leader_email)}">${escapeText(unit.leader_email)}</a></dd>` : ''}
      ${unit.leader_phone ? `<dt>Phone</dt><dd>${escapeText(unit.leader_phone)}</dd>` : ''}
    </dl>` : emptyState('Leadership position is currently vacant.');

  const childRows = children.length
    ? `<ul class="org-tree">${children.map((c) => `<li class="org-node"><div class="org-row">${levelBadge(c.level)}<a class="org-name" href="/org/${c.id}">${escapeText(c.name)}</a>${leaderLine(c)}</div></li>`).join('')}</ul>`
    : emptyState('No sub-units.');

  const body = html`
    <p class="crumbs">${raw(crumbs)}</p>
    <div class="detail-head">
      <h1>${raw(levelBadge(unit.level))} ${unit.name}</h1>
      <a class="btn" href="/admin/org/${unit.id}/edit">Manage</a>
    </div>
    ${raw(card('Leadership', leaderCard))}
    ${unit.description ? raw(card('About', `<p>${escapeText(unit.description)}</p>`)) : ''}
    ${raw(card('Sub-units', childRows))}`;
  return layout({ title: unit.name, active: '/org', body });
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
      : emptyState('No units yet — add your first division.')))}`;
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

  const form = html`
    <form class="form" method="post" action="${action}">
      <div class="form-row">
        <label>Level<select name="level" required>${raw(levelOpts)}</select></label>
        <label>Reports to (parent)<select name="parent_id">${raw(parentOpts)}</select></label>
      </div>
      <label>Name<input type="text" name="name" required value="${unit ? unit.name : ''}" placeholder="e.g. Department of Public Works"></label>
      <fieldset>
        <legend>Leader</legend>
        <div class="form-row">
          <label>Name<input type="text" name="leader_name" value="${unit ? (unit.leader_name || '') : ''}" placeholder="Individual leader"></label>
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
  const body = html`
    <p class="crumbs"><a href="/admin/org">Manage organization</a> / ${isEdit ? escapeText(unit.name) : 'New unit'}</p>
    <h1>${isEdit ? 'Edit ' + escapeText(unit.name) : 'New organizational unit'}</h1>
    ${raw(card(isEdit ? 'Unit details' : 'Create unit', form))}`;
  return layout({ title: isEdit ? 'Edit unit' : 'New unit', active: '/admin', body });
}

module.exports = { orgDirectory, orgUnitDetail, orgAdmin, orgForm };
