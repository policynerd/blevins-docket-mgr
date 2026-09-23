export const metadata = { title: 'Privacy' };

export default function PrivacyPage() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="ref">How this official system handles identity and records</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <p>
          Sign-in is handled by the organization’s Microsoft Entra tenant. This application
          stores your name, email, and the files you create or edit. Session cookies are
          httpOnly and are used only to keep you signed in.
        </p>
        <p>
          Legislative files, agendas, votes, and packets are official business records. They
          are not consumer accounts and are not offered to the public as a personal service.
        </p>
        <p>
          Questions about retention or access should go to the Office of the General Counsel.
        </p>
      </div>
    </>
  );
}
