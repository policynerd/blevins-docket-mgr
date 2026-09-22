import { ORG } from './org.ts';

const org = ORG.name;

export const DETAILED_FORMS: Record<string, string> = {
  Ordinance: `Having regard to the Operating Agreement of ${org};
Having regard to the charter of the Board of Governors;

WHEREAS, the Board has considered the findings set out in the accompanying Board letter; and
WHEREAS, the action authorised by this ordinance is within the Board's reserved powers; and
WHEREAS, notice has been given in the manner required by the Board's procedures;

NOW, THEREFORE, the Board of Governors of ${org} ordains as follows:

SECTION 1. Short title.
This ordinance may be cited as the "____ Ordinance, 2026".

SECTION 2. Findings.
The Board finds that—
(a) ____;
(b) ____; and
(c) the fiscal effect is as stated in the accompanying Fiscal Impact Statement.

SECTION 3. Definitions.
In this ordinance—
(a) "Board" means the Board of Governors of ${org};
(b) "Clerk" means the Clerk of the Board;
(c) "____" means ____.

SECTION 4. Operative provision.
(a) In general. ____
(b) Administration. The ____ shall—
(1) ____;
(2) ____; and
(3) keep a record sufficient to demonstrate compliance.
(c) Standards. In discharging subsection (b) the ____ shall apply ____.
(d) Reporting. Not later than ____ of each year, the ____ shall report to the Board on ____.

SECTION 5. Conforming amendments.
Section ____ of the ${org} Administrative Code is amended by striking "____" and inserting "____".

SECTION 6. Severability.
If any provision of this ordinance, or its application to any person or circumstance, is held invalid, the remainder of this ordinance and its application to other persons or circumstances are not affected.

SECTION 7. Effective date.
This ordinance takes effect thirty (30) days after adoption, unless a later date is stated in section 4.`,

  Amendatory: `Having regard to the Operating Agreement of ${org};

WHEREAS, section ____ of the ${org} Administrative Code no longer states the rule the Board intends to apply; and
WHEREAS, the amendment below is confined to that defect;

NOW, THEREFORE, the Board of Governors of ${org} ordains as follows:

SECTION 1. Short title.
This ordinance may be cited as the "____ Amendment Ordinance, 2026".

SECTION 2. Amendment of section ____ of the ${org} Administrative Code.
Section ____ of the ${org} Administrative Code is amended to read as follows:
(a) ____
(b) ____
(c) ____

SECTION 3. Conforming amendments.
(a) Section ____ is amended by striking "____" and inserting "____".
(b) The Clerk shall republish the affected title within thirty days of adoption.

SECTION 4. Transitional.
A proceeding begun before the effective date continues under the former text unless the Board directs otherwise.

SECTION 5. Effective date.
This ordinance takes effect ____.`,

  Resolution: `Having regard to the Operating Agreement of ${org};

WHEREAS, ____; and
WHEREAS, ____; and
WHEREAS, the Board has received the accompanying Board letter and finds the facts stated in it;

NOW, THEREFORE, BE IT RESOLVED by the Board of Governors of ${org}:

SECTION 1. Decision.
The Board hereby ____.

SECTION 2. Conditions.
(a) The action in section 1 is subject to ____.
(b) No payment may be made except from funds appropriated for that purpose.

SECTION 3. Direction to staff.
The ____ is directed to ____ and to report to the Board not later than ____.

SECTION 4. Record.
The Clerk shall enter this resolution in the minutes of the meeting at which it is adopted and shall furnish a certified copy to ____.

SECTION 5. Effective date.
This resolution takes effect immediately upon adoption.`,

  Action: `WHEREAS, the matter described in the accompanying Board letter is before the Board for decision; and
WHEREAS, the Board has considered the alternatives stated in that letter;

NOW, THEREFORE, BE IT RESOLVED by the Board of Governors of ${org}:

SECTION 1. Action.
The Board ____.

SECTION 2. Direction to staff.
The ____ is directed to ____ and to report to the Board on ____.

SECTION 3. Effective date.
This takes effect immediately upon adoption.`,

  Information: `SECTION 1. Purpose.
This item is submitted to the Board of Governors of ${org} for information. No action is requested.

SECTION 2. Background.
____

SECTION 3. Discussion.
(a) Facts. ____
(b) Options the Board may later be asked to consider. ____

SECTION 4. Next appearance.
Staff expect to return on ____ with ____.`,

  Motion: `SECTION 1. Motion.
I move that the Board of Governors of ${org} ____.

SECTION 2. If adopted.
Upon adoption the Clerk shall record the motion as the action of the Board and the ____ shall ____.`,

  Contract: `WHEREAS, the Board has reviewed the proposed agreement described in the accompanying Board letter; and
WHEREAS, compensation and term are within the authority reserved to the Board;

NOW, THEREFORE, BE IT RESOLVED by the Board of Governors of ${org}:

SECTION 1. Authorization.
The Board authorizes the ____ to execute an agreement with ____ for ____, substantially in the form attached.

SECTION 2. Terms.
(a) Scope. The agreement shall provide for ____.
(b) Compensation. Compensation may not exceed $____ over the term, exclusive of ____.
(c) Term. The agreement commences ____ and ends ____, with ____ option(s) to renew of ____ each.
(d) Source of funds. Payments shall be charged to ____.

SECTION 3. Conditions.
(a) The agreement is subject to approval as to form by Board Counsel.
(b) No payment may be made except from funds appropriated for that purpose.
(c) A fully executed copy shall be filed with the Clerk within ten days of signature.

SECTION 4. Effective date.
This authorization takes effect immediately upon adoption.`,

  Appointment: `WHEREAS, a vacancy exists on the ____; and
WHEREAS, the nominee meets the qualifications stated in the governing instrument;

NOW, THEREFORE, BE IT RESOLVED by the Board of Governors of ${org}:

SECTION 1. Appointment.
The Board appoints ____ of ____ to the ____.

SECTION 2. Term.
The term begins ____ and ends ____, or until a successor is appointed.

SECTION 3. Oath and filing.
The Clerk shall administer the oath, if one is required, and shall file this appointment with the record of the body.

SECTION 4. Effective date.
This appointment takes effect immediately upon adoption.`,

  'Public Hearing': `SECTION 1. Notice.
NOTICE IS HEREBY GIVEN that the Board of Governors of ${org} will hold a public hearing:

Date: ____
Time: ____
Place: 4895 Executive Drive, Board Chambers | B 250, San Diego, CA 92121
or by the remote means posted with the agenda.

SECTION 2. Subject.
The hearing concerns ____.

SECTION 3. Materials.
The Board letter, proposed instrument, and fiscal statement are available from the Clerk and will be posted with the agenda.

SECTION 4. Participation.
(a) Written comment may be submitted to the Clerk of the Board until ____ Pacific Time on ____.
(b) Persons wishing to be heard may register with the Clerk before the hearing, or when recognized by the Chair.
(c) Comments are limited to ____ minutes unless the Chair extends the time.

SECTION 5. Decision.
The Board may act at the close of the hearing or may continue the matter.`,

  Proclamation: `WHEREAS, ____; and
WHEREAS, ____;

NOW, THEREFORE, the Board of Governors of ${org} proclaims:

SECTION 1. Proclamation.
____ is hereby recognized as ____.

SECTION 2. Presentation.
The Clerk is directed to prepare an engrossed copy under the seal of the Board for presentation to ____.`,

  Report: `SECTION 1. Purpose.
____

SECTION 2. Findings.
(a) ____
(b) ____
(c) ____

SECTION 3. Recommendation.
The ____ recommends that the Board of Governors of ${org} ____.

SECTION 4. Attachments.
The following papers accompany this report: ____.`,

  Communication: `SECTION 1. From.
____

SECTION 2. Subject.
____

SECTION 3. Requested of the Board.
Receive and file. / Refer to ____. / Calendar for action on ____.`,
};
