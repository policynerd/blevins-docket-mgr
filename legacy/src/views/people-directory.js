'use strict';

const { html, raw, todayISO } = require('../util');
const { layout, escapeText } = require('./layout');
const { ORG } = require('../org');
const repo = require('../repo');

function initials(name) {
  return String(name || '').split(/\s+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join('');
}

function occupying(m, asOf) {
  if (m.start_date && m.start_date > asOf) return false;
  if (m.end_date && m.end_date < asOf) return false;
  return true;
}

function isCommitteeBody(b) {
  return /committee|commission/i.test(String(b.type || ''))
    || /committee|commission/i.test(String(b.name || ''));
}

function isGoverningBody(b) {
  if (!b) return false;
  if (b.name === ORG.primaryBody) return true;
  if (b.type === ORG.primaryBodyType) return true;
  return /governing|board of governors/i.test(`${b.type} ${b.name}`);
}

function personCard(p, line) {
  return html`
    <a class="person-card" href="/people/${p.id}">
      <span class="avatar">${initials(p.full_name)}</span>
      <span class="pc-body">
        <strong>${p.full_name}</strong>
        <span class="muted">${escapeText(line || [p.title, p.district].filter(Boolean).join(' · '))}</span>
      </span>
    </a>`;
}

function section(title, note, cards, href) {
  if (!cards.length) return '';
  const heading = href
    ? `<h2 style="margin:0 0 6px;font-size:1.15rem"><a href="${escapeText(href)}">${escapeText(title)}</a></h2>`
    : `<h2 style="margin:0 0 6px;font-size:1.15rem">${escapeText(title)}</h2>`;
  return `
    <section class="directory-section" style="margin:0 0 32px">
      ${heading}
      ${note ? `<p class="muted" style="margin:0 0 12px">${escapeText(note)}</p>` : ''}
      <div class="person-grid">${cards.join('')}</div>
    </section>`;
}

function peopleList() {
  const today = todayISO();
  const bodies = repo.bodies.all(true);
  const board = bodies.find(isGoverningBody) || bodies.find((b) => !isCommitteeBody(b)) || null;
  const committees = bodies.filter((b) => b !== board && isCommitteeBody(b));

  const boardMembers = board
    ? repo.bodies.members(board.id).filter((m) => occupying(m, today))
    : [];
  const boardIds = new Set(boardMembers.map((m) => m.person_id));

  const governorCards = boardMembers.map((m) =>
    personCard(m, [m.role, m.district || m.title].filter(Boolean).join(' · ')));

  const committeeBlocks = committees.map((c) => {
    const members = repo.bodies.members(c.id).filter((m) => occupying(m, today));
    if (!members.length) return '';
    const cards = members.map((m) =>
      personCard(m, [m.role, boardIds.has(m.person_id) ? 'also a Governor' : c.name].filter(Boolean).join(' · ')));
    return section(c.name, `${members.length} sitting member${members.length === 1 ? '' : 's'}`, cards, `/bodies/${c.id}`);
  }).filter(Boolean);

  const listed = new Set(boardIds);
  for (const c of committees) {
    for (const m of repo.bodies.members(c.id)) listed.add(m.person_id);
  }
  const other = repo.people.all(true).filter((p) => !listed.has(p.id));
  const otherCards = other.map((p) => personCard(p, [p.title, p.district].filter(Boolean).join(' · ')));

  const body = html`
    ${raw(section(
      board ? board.name : ORG.membersLabel,
      'Sitting members of the governing body. Committee service is listed below, not mixed in here.',
      governorCards,
      board ? `/bodies/${board.id}` : '/bodies',
    ))}
    ${committeeBlocks.length
      ? raw(`<h2 style="margin:8px 0 16px;font-size:1.15rem">Committees</h2>${committeeBlocks.join('')}`)
      : ''}
    ${raw(section(
      'Other officials',
      'Officers, inspectors, and other people of record who do not hold a Board seat.',
      otherCards,
    ))}
  `;

  return layout({
    title: ORG.membersLabel,
    active: '/people',
    subtitle: 'The Board, then its committees, then everyone else.',
    body,
  });
}

module.exports = { peopleList };
