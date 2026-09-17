// Who the Board is.
//
// Taken from the Board's current membership roster (sitting members only).
// Dan Blevins resigned; term concluded 2026-08-14. He stays in the chamber
// people table as history. He does not belong on the face of an instrument.
//
// This lives in code for now. It belongs in the database once there is a
// screen to administer it, and the shape below is what that table will hold.

export interface Officer {
  readonly name: string;
  /** "Chair" / "Member" / "Ex-Officio" for a governor, office title for staff. */
  readonly title: string;
  readonly email?: string;
}

export const GOVERNORS: readonly Officer[] = [
  { name: 'Benjamin Blevins', title: 'Chair', email: 'benjamin.blevins@blevinsholdings.com' },
  { name: 'Ashley Dominguez', title: 'Member' },
  { name: 'Dr. Jessica Robinson', title: 'Member' },
  { name: 'Jan Blevins', title: 'Member' },
  { name: 'Julianna A. Barnes', title: 'Member' },
  { name: 'Lynn Neault', title: 'Member' },
  { name: 'Mason Nakamura', title: 'Ex-Officio' },
  { name: 'Matthew Blevins', title: 'Member' },
  { name: 'Patricia Kay Coleman', title: 'Member' },
];

export const STAFF: readonly Officer[] = [
  { name: 'Brian Caldwell', title: 'Clerk of the Board' },
  { name: 'Anna Ramirez', title: 'Deputy Clerk' },
  { name: 'Isaiah Rostowitz', title: 'Deputy Clerk' },
  { name: 'Colleen Smith', title: 'Board Counsel' },
  { name: 'Mason Nakamura', title: 'Board Treasurer' },
];

export const ORG = {
  name: 'Blevins Holdings',
  body: 'Board of Governors',
  chambers: ['4895 Executive Drive', 'Board Chambers | B 250', 'San Diego, CA 92121 USA'],
} as const;
