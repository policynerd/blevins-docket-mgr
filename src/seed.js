'use strict';

// Seeds the database with a fictional municipality so the app demonstrates the
// full legislative lifecycle: files, sponsors, history, meetings, agendas, votes.
const { db, init, reset } = require('./db');
const repo = require('./repo');

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function run() {
  const wantReset = process.argv.includes('--reset');
  if (wantReset) reset(); else init();

  const existing = db.prepare('SELECT COUNT(*) AS n FROM people').get().n;
  if (existing > 0 && !wantReset) {
    console.log('Database already seeded. Use --reset to rebuild.');
    return;
  }

  const tx = db.exec.bind(db);
  tx('BEGIN');
  try {
    // --- People -----------------------------------------------------------
    const P = {};
    const peopleSeed = [
      ['Marlena Ortiz', 'Council President', 'District 1', 'Independent', 'mortiz@city.gov'],
      ['Daniel Cho', 'Councilmember', 'District 2', 'Civic Party', 'dcho@city.gov'],
      ['Priya Nair', 'Councilmember', 'District 3', 'Independent', 'pnair@city.gov'],
      ['Walter Briggs', 'Councilmember', 'District 4', 'Reform', 'wbriggs@city.gov'],
      ['Sofia Almeida', 'Councilmember', 'District 5', 'Civic Party', 'salmeida@city.gov'],
      ['Theo Jackson', 'Councilmember', 'District 6', 'Independent', 'tjackson@city.gov'],
      ['Grace Lindqvist', 'Councilmember', 'At-Large', 'Reform', 'glindqvist@city.gov'],
      ['Hector Alvarez', 'Mayor', 'Citywide', 'Civic Party', 'mayor@city.gov'],
      ['Eleanor Pace', 'City Clerk', 'Administration', '', 'clerk@city.gov'],
    ];
    for (const [name, title, district, party, email] of peopleSeed) {
      P[name] = repo.people.insert({
        full_name: name, title, district, party, email,
        phone: '(555) 010-' + String(1000 + Object.keys(P).length).slice(1),
        bio: `${name} serves the City as ${title}${district ? ' representing ' + district : ''}.`,
      });
    }

    // --- Bodies -----------------------------------------------------------
    const B = {};
    B.council = repo.bodies.insert({
      name: 'City Council', type: 'Primary Legislative Body',
      description: 'The legislative authority of the City, responsible for adopting ordinances, resolutions, and the annual budget.',
      meeting_location: 'Council Chambers, City Hall', meets: '1st & 3rd Tuesdays, 6:00 PM',
    });
    B.finance = repo.bodies.insert({
      name: 'Finance Committee', type: 'Standing Committee',
      description: 'Reviews appropriations, contracts, and fiscal policy before referral to the full Council.',
      meeting_location: 'Committee Room A', meets: '2nd Mondays, 4:00 PM',
    });
    B.safety = repo.bodies.insert({
      name: 'Public Safety Committee', type: 'Standing Committee',
      description: 'Oversees police, fire, and emergency management matters.',
      meeting_location: 'Committee Room B', meets: '2nd Wednesdays, 4:00 PM',
    });
    B.planning = repo.bodies.insert({
      name: 'Planning Commission', type: 'Commission',
      description: 'Advises on land use, zoning, and the comprehensive plan.',
      meeting_location: 'Council Chambers, City Hall', meets: '4th Thursdays, 6:30 PM',
    });

    // --- Memberships ------------------------------------------------------
    repo.bodies.addMember(B.council, P['Marlena Ortiz'], 'Chair');
    for (const name of ['Daniel Cho', 'Priya Nair', 'Walter Briggs', 'Sofia Almeida', 'Theo Jackson', 'Grace Lindqvist']) {
      repo.bodies.addMember(B.council, P[name], 'Member');
    }
    repo.bodies.addMember(B.finance, P['Daniel Cho'], 'Chair');
    repo.bodies.addMember(B.finance, P['Sofia Almeida'], 'Vice Chair');
    repo.bodies.addMember(B.finance, P['Grace Lindqvist'], 'Member');
    repo.bodies.addMember(B.safety, P['Walter Briggs'], 'Chair');
    repo.bodies.addMember(B.safety, P['Theo Jackson'], 'Member');
    repo.bodies.addMember(B.safety, P['Priya Nair'], 'Member');
    repo.bodies.addMember(B.planning, P['Priya Nair'], 'Chair');
    repo.bodies.addMember(B.planning, P['Sofia Almeida'], 'Member');

    // --- Matters ----------------------------------------------------------
    function makeMatter(spec) {
      const fileNumber = repo.matters.nextFileNumber(spec.type);
      const id = repo.matters.insert({
        file_number: fileNumber, type: spec.type, title: spec.title,
        status: spec.status, body_id: spec.body_id, intro_date: spec.intro_date,
        summary: spec.summary, full_text: spec.full_text,
      });
      for (const s of spec.sponsors || []) {
        repo.matters.addSponsor(id, P[s.name], s.type || 'Sponsor');
      }
      for (const h of spec.history || []) {
        repo.matters.addHistory({
          matter_id: id, action_date: h.date, body_id: h.body,
          action: h.action, result: h.result, notes: h.notes,
        });
      }
      for (const a of spec.attachments || []) {
        repo.matters.addAttachment({ matter_id: id, name: a.name, url: a.url, note: a.note });
      }
      return { id, file_number: fileNumber };
    }

    const m1 = makeMatter({
      type: 'Ordinance',
      title: 'An Ordinance establishing a Climate Resilience and Tree Canopy Program',
      status: 'Enacted', body_id: B.council, intro_date: daysFromNow(-48),
      summary: 'Creates a citywide program to expand the urban tree canopy to 40% by 2035 and establishes a dedicated resilience fund.',
      full_text: 'BE IT ORDAINED by the City Council:\n\nSection 1. Purpose. The City hereby establishes the Climate Resilience and Tree Canopy Program...\n\nSection 2. Canopy Goal. The City shall pursue a tree canopy coverage target of forty percent (40%) by the year 2035...\n\nSection 3. Resilience Fund. There is hereby created a dedicated fund...',
      sponsors: [{ name: 'Sofia Almeida', type: 'Primary' }, { name: 'Priya Nair' }],
      history: [
        { date: daysFromNow(-48), body: B.council, action: 'Introduced and referred to Finance Committee' },
        { date: daysFromNow(-34), body: B.finance, action: 'Recommended for adoption', result: 'Pass' },
        { date: daysFromNow(-20), body: B.council, action: 'Adopted on second reading', result: 'Pass' },
        { date: daysFromNow(-18), body: B.council, action: 'Signed by the Mayor' },
      ],
      attachments: [{ name: 'Staff report — canopy analysis.pdf', url: '#' }, { name: 'Fiscal note.pdf', url: '#' }],
    });

    const m2 = makeMatter({
      type: 'Resolution',
      title: 'A Resolution authorizing a contract for the Riverside Bridge rehabilitation',
      status: 'Passed', body_id: B.council, intro_date: daysFromNow(-30),
      summary: 'Authorizes the City Manager to execute a $4.2M construction contract with Keystone Infrastructure for the Riverside Bridge.',
      sponsors: [{ name: 'Daniel Cho', type: 'Primary' }],
      history: [
        { date: daysFromNow(-30), body: B.council, action: 'Introduced and referred to Finance Committee' },
        { date: daysFromNow(-16), body: B.finance, action: 'Recommended for approval', result: 'Pass' },
        { date: daysFromNow(-2), body: B.council, action: 'Adopted', result: 'Pass' },
      ],
      attachments: [{ name: 'Bid tabulation.pdf', url: '#' }],
    });

    const m3 = makeMatter({
      type: 'Ordinance',
      title: 'An Ordinance amending the Zoning Code to permit accessory dwelling units',
      status: 'In Committee', body_id: B.planning, intro_date: daysFromNow(-12),
      summary: 'Amends Title 17 to allow accessory dwelling units (ADUs) by right in all residential zones, subject to design standards.',
      full_text: 'BE IT ORDAINED:\n\nSection 1. Title 17 (Zoning) is amended to permit one accessory dwelling unit per residential lot...',
      sponsors: [{ name: 'Priya Nair', type: 'Primary' }, { name: 'Theo Jackson' }],
      history: [
        { date: daysFromNow(-12), body: B.council, action: 'Introduced and referred to Planning Commission' },
        { date: daysFromNow(-1), body: B.planning, action: 'Public hearing held; continued for revisions', result: 'Held' },
      ],
    });

    const m4 = makeMatter({
      type: 'Resolution',
      title: 'A Resolution adopting the FY2027 Capital Improvement Program',
      status: 'In Committee', body_id: B.finance, intro_date: daysFromNow(-9),
      summary: 'Adopts the six-year Capital Improvement Program totaling $128M, prioritizing transit, water, and parks.',
      sponsors: [{ name: 'Daniel Cho', type: 'Primary' }, { name: 'Grace Lindqvist' }],
      history: [
        { date: daysFromNow(-9), body: B.council, action: 'Introduced and referred to Finance Committee' },
      ],
    });

    const m5 = makeMatter({
      type: 'Ordinance',
      title: 'An Ordinance prohibiting single-use polystyrene food containers',
      status: 'Introduced', body_id: B.council, intro_date: daysFromNow(-5),
      summary: 'Phases out expanded polystyrene food service containers citywide over 12 months.',
      sponsors: [{ name: 'Sofia Almeida', type: 'Primary' }],
      history: [
        { date: daysFromNow(-5), body: B.council, action: 'Introduced; referral pending' },
      ],
    });

    const m6 = makeMatter({
      type: 'Appointment',
      title: 'Appointment of Rosa Méndez to the Planning Commission',
      status: 'On Agenda', body_id: B.council, intro_date: daysFromNow(-4),
      summary: 'Mayoral appointment of Rosa Méndez to fill a vacancy on the Planning Commission for a three-year term.',
      sponsors: [{ name: 'Hector Alvarez', type: 'Primary' }],
      history: [{ date: daysFromNow(-4), body: B.council, action: 'Received and filed' }],
    });

    const m7 = makeMatter({
      type: 'Motion',
      title: 'A Motion directing a staff study on speed-management on Elm Street',
      status: 'Passed', body_id: B.safety, intro_date: daysFromNow(-22),
      summary: 'Directs the Department of Transportation to study traffic-calming measures along the Elm Street corridor.',
      sponsors: [{ name: 'Walter Briggs', type: 'Primary' }],
      history: [
        { date: daysFromNow(-22), body: B.safety, action: 'Adopted by committee', result: 'Pass' },
      ],
    });

    const m8 = makeMatter({
      type: 'Resolution',
      title: 'A Resolution recognizing Small Business Week',
      status: 'Draft', body_id: B.council, intro_date: null,
      summary: 'Proclaims the second week of October as Small Business Week and honors local entrepreneurs.',
      sponsors: [{ name: 'Grace Lindqvist', type: 'Primary' }],
    });

    const m9 = makeMatter({
      type: 'Ordinance',
      title: 'An Ordinance updating the City fee schedule for FY2027',
      status: 'Failed', body_id: B.council, intro_date: daysFromNow(-40),
      summary: 'Proposed across-the-board increases to permit and licensing fees; failed on second reading.',
      sponsors: [{ name: 'Daniel Cho', type: 'Primary' }],
      history: [
        { date: daysFromNow(-40), body: B.council, action: 'Introduced and referred to Finance Committee' },
        { date: daysFromNow(-26), body: B.finance, action: 'Recommended for adoption', result: 'Pass' },
        { date: daysFromNow(-12), body: B.council, action: 'Failed on second reading', result: 'Fail' },
      ],
    });

    // --- Documents / reports (word-processor output) ---------------------
    repo.reports.insert({
      matter_id: m1.id, title: 'Staff Report — Climate Resilience & Tree Canopy', kind: 'Staff Report',
      body_html: '<h2>Purpose</h2><p>This report supports the proposed ordinance establishing a citywide '
        + '<strong>Climate Resilience and Tree Canopy Program</strong>.</p><h3>Background</h3>'
        + '<p>The current canopy covers an estimated 28% of the city. Staff recommends a target of '
        + '<strong>40% by 2035</strong>.</p><h3>Recommendation</h3><ul><li>Adopt the ordinance.</li>'
        + '<li>Establish the dedicated resilience fund.</li><li>Direct staff to report annually.</li></ul>',
    });
    repo.reports.insert({
      matter_id: m4.id, title: 'Fiscal Note — FY2027 Capital Improvement Program', kind: 'Fiscal Note',
      body_html: '<p>The six-year CIP totals <strong>$128M</strong>, with priority allocations to '
        + 'transit, water infrastructure, and parks. No new debt issuance is required in the first year.</p>',
    });

    // --- Meetings & agendas ----------------------------------------------
    // Past council meeting (with recorded votes)
    const pastMeeting = repo.meetings.insert({
      body_id: B.council, meeting_date: daysFromNow(-2), meeting_time: '6:00 PM',
      location: 'Council Chambers, City Hall', status: 'Final',
      minutes_url: '#', video_url: '#',
    });
    repo.meetings.addItem({ meeting_id: pastMeeting, section: 'Call to Order', agenda_number: '1', title: 'Call to Order & Roll Call' });
    repo.meetings.addItem({ meeting_id: pastMeeting, section: 'Approval of Minutes', agenda_number: '2', title: 'Approval of Minutes — prior regular meeting' });
    const ai_bridge = repo.meetings.addItem({
      meeting_id: pastMeeting, matter_id: m2.id, section: 'Resolutions',
      agenda_number: '5.A', action: 'Motion to adopt', result: 'Pass',
    });
    const ai_fee = repo.meetings.addItem({
      meeting_id: pastMeeting, matter_id: m9.id, section: 'Ordinances',
      agenda_number: '6.A', action: 'Motion to adopt on second reading', result: 'Fail',
    });

    // Record votes for the two substantive items
    const council = ['Marlena Ortiz', 'Daniel Cho', 'Priya Nair', 'Walter Briggs', 'Sofia Almeida', 'Theo Jackson', 'Grace Lindqvist'];
    const bridgeVotes = { 'Walter Briggs': 'Nay' }; // everyone else Yea
    for (const name of council) {
      repo.votes.record(ai_bridge, P[name], bridgeVotes[name] || 'Yea');
    }
    const feeVotes = { 'Daniel Cho': 'Yea', 'Marlena Ortiz': 'Yea', 'Grace Lindqvist': 'Yea' };
    for (const name of council) {
      repo.votes.record(ai_fee, P[name], feeVotes[name] || 'Nay');
    }

    // Upcoming council meeting (agenda posted, no votes yet)
    const nextMeeting = repo.meetings.insert({
      body_id: B.council, meeting_date: daysFromNow(7), meeting_time: '6:00 PM',
      location: 'Council Chambers, City Hall', status: 'Scheduled', agenda_url: '#',
    });
    repo.meetings.addItem({ meeting_id: nextMeeting, section: 'Call to Order', agenda_number: '1', title: 'Call to Order & Roll Call' });
    repo.meetings.addItem({ meeting_id: nextMeeting, section: 'Public Comment', agenda_number: '3', title: 'Public Comment' });
    repo.meetings.addItem({ meeting_id: nextMeeting, matter_id: m5.id, section: 'Ordinances', agenda_number: '6.A' });
    repo.meetings.addItem({ meeting_id: nextMeeting, matter_id: m6.id, section: 'New Business', agenda_number: '7.A' });
    repo.meetings.addItem({ meeting_id: nextMeeting, matter_id: m4.id, section: 'Resolutions', agenda_number: '5.A' });

    // Upcoming committee meeting
    const finMeeting = repo.meetings.insert({
      body_id: B.finance, meeting_date: daysFromNow(3), meeting_time: '4:00 PM',
      location: 'Committee Room A', status: 'Scheduled', agenda_url: '#',
    });
    repo.meetings.addItem({ meeting_id: finMeeting, matter_id: m4.id, section: 'New Business', agenda_number: '2.A' });

    // Planning commission meeting (past)
    const planMeeting = repo.meetings.insert({
      body_id: B.planning, meeting_date: daysFromNow(-1), meeting_time: '6:30 PM',
      location: 'Council Chambers, City Hall', status: 'Final', minutes_url: '#',
    });
    repo.meetings.addItem({
      meeting_id: planMeeting, matter_id: m3.id, section: 'Public Hearings',
      agenda_number: '4.A', action: 'Public hearing; continued', result: 'Held',
    });

    tx('COMMIT');
  } catch (err) {
    tx('ROLLBACK');
    throw err;
  }

  const s = repo.stats();
  console.log('Seed complete:', JSON.stringify(s));
}

if (require.main === module) {
  run();
}

module.exports = { run };
