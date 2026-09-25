export const metadata = { title: 'Accessibility' };

export default function AccessibilityPage() {
  return (
    <>
      <h1>Accessibility</h1>
      <p className="ref">Access to the official website of the Board of Governors</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <p>
          The Board of Governors intends this site to meet WCAG 2.2 Level AA. That is the
          accessibility target for this system. We are not a federal agency and do not claim
          Section 508 coverage.
        </p>
        <p>Formats:</p>
        <ul>
          <li>Official copies of instruments are HTML on this site.</li>
          <li>Packets are also offered as PDF. Request another format from counsel if a table or figure is unusable.</li>
          <li>The drafting editor is a structured document surface. Some assistive technology may announce Akoma Ntoso element names.</li>
        </ul>
        <p>
          To request another means of access, contact the Office of the General Counsel and
          name the page and what you were trying to do.
        </p>
      </div>
      <p className="policy-updated">Last update: 24 September 2026</p>
    </>
  );
}
