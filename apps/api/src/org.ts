// Who the Board is.
//
// Taken from the Board's own posted meeting notice, which is the authoritative
// statement of composition — the same document the masthead appears on. Seats
// are numbered rather than named districts, and the order here is the order
// they are printed in; both matter, because the masthead is read as a roster
// and a governor appearing out of seat order reads as an error.
//
// This lives in code for now. It belongs in the database once there is a
// screen to administer it, and the shape below is what that table will hold.

export interface Officer {
  readonly name: string;
  /** "Seat One" for a governor, "Clerk of the Board" for staff. */
  readonly title: string;
  readonly email?: string;
}

export const GOVERNORS: readonly Officer[] = [
  { name: 'Benjamin Blevins', title: 'Seat One', email: 'benjamin.blevins@blevinsholdings.com' },
  { name: 'Daniel Blevins', title: 'Seat Two' },
  { name: 'Matthew Blevins', title: 'Seat Three' },
  { name: 'Janet Stanton-Blevins', title: 'Seat Four' },
  { name: 'Lynn Neault', title: 'Seat Five' },
  { name: 'Julianna Barnes', title: 'Seat Six' },
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
