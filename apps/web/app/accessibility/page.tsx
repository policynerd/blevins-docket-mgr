export const metadata = { title: 'Accessibility' };

export default function AccessibilityPage() {
  return (
    <>
      <h1>Accessibility</h1>
      <p className="ref">WCAG 2.2 AA intent for this official site</p>
      <div className="prose card" style={{ padding: '1.5rem', marginTop: '1.25rem' }}>
        <p>
          The Board of Governors intends this drafting system to meet WCAG 2.2 Level AA.
          Pages use semantic headings, visible focus, text alternatives on the seal, and
          contrast on navy and gold chrome.
        </p>
        <p>
          Known limits: the legislative editor is a structured document surface. Some assistive
          technology may read Akoma Ntoso element names. PDF packets are tagged through the
          HTML source used to print them; complex tables in fiscal notes may need a text
          equivalent.
        </p>
        <p>
          Report a barrier to the Office of the General Counsel and identify the page and what
          you were trying to do.
        </p>
      </div>
    </>
  );
}
