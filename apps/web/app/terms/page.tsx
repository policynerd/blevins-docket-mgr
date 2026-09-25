export const metadata = { title: 'Terms of use' };

export default function TermsPage() {
  return (
    <>
      <h1>Terms of use</h1>
      <p className="ref">Official drafting system of the Board of Governors</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <p>
          This site is the official legislative drafting system of the Blevins Holdings Board
          of Governors. It is for authorized officers, counsel, and staff to prepare,
          circulate, and enact instruments of the Board.
        </p>
        <p>
          Content you create here is an official record. Do not use the system for personal
          business. Do not share a signed-in session.
        </p>
        <p>
          Access is limited to accounts issued by the organization. Altering an adopted
          instrument after enactment without a subsequent official action is prohibited.
        </p>
      </div>
      <p className="policy-updated">Last update: 24 September 2026</p>
    </>
  );
}
