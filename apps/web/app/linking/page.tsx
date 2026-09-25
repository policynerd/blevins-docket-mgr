export const metadata = { title: 'Website linking policy' };

export default function LinkingPage() {
  return (
    <>
      <h1>Website linking policy</h1>
      <p className="ref">How this official site treats outbound links</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <p>
          This site links to other Blevins Holdings properties and, where useful, to external
          sites. A link is a convenience. It is not an endorsement of the destination, its
          sponsor, or its privacy practices.
        </p>
        <p>
          When you follow a link that leaves this host you leave this system&apos;s privacy and
          security rules. The destination may use its own cookies and terms.
        </p>
        <p>
          We do not guarantee that an external site meets WCAG 2.2. Official Board records are
          published on this system or the docket manager, not on a third-party page.
        </p>
      </div>
      <p className="policy-updated">Last update: 24 September 2026</p>
    </>
  );
}
