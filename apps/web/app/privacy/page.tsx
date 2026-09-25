export const metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="ref">Identity and records on this official system</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <p>
          Sign-in uses the organization&apos;s Microsoft Entra tenant. This application stores
          your name, email, and the files you create or edit. Session cookies are httpOnly and
          exist only to keep you signed in.
        </p>
        <p>
          Legislative files, agendas, votes, and packets are official business records. They
          are not consumer accounts.
        </p>
        <p>
          Drafts stay private until an authorized officer publishes them. Questions about
          retention or access go to the Office of the General Counsel.
        </p>
      </div>
      <p className="policy-updated">Last update: 24 September 2026</p>
    </>
  );
}
