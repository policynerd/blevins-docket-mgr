export const metadata = { title: 'Site map' };

export default function SitemapPage() {
  return (
    <>
      <h1>Site map</h1>
      <p className="ref">Public pages on this official system</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <h2>Records and drafting</h2>
        <ul>
          <li>
            <a href="/">Legislation</a>
          </li>
          <li>
            <a href="/docket">Today&apos;s docket</a>
          </li>
          <li>
            <a href="/meetings">Meetings</a>
          </li>
          <li>
            <a href="/templates">Drafting templates</a>
          </li>
          <li>
            <a href="/publications">Published records</a>
          </li>
          <li>
            <a href="/proposals/new">New file</a> (sign-in required)
          </li>
        </ul>
        <h2>Help and administration</h2>
        <ul>
          <li>
            <a href="/help">Help</a>
          </li>
          <li>
            <a href="/settings">Administration</a> (sign-in required)
          </li>
        </ul>
        <h2>Policies</h2>
        <ul>
          <li>
            <a href="/terms">Terms of use</a>
          </li>
          <li>
            <a href="/privacy">Privacy</a>
          </li>
          <li>
            <a href="/accessibility">Accessibility</a>
          </li>
          <li>
            <a href="/linking">Linking policy</a>
          </li>
        </ul>
      </div>
      <p className="policy-updated">Last update: 24 September 2026</p>
    </>
  );
}
