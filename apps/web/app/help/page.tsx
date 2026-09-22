export default function HelpPage() {
  return (
    <>
      <h1>How to draft</h1>
      <div className="ref">This is not Word. Each line is a provision. Click it, type, click away to save.</div>

      <div className="help-stack">
        <section className="card" style={{ padding: 'var(--space-5)' }}>
          <h2>1. Pick an instrument</h2>
          <p>
            Open <a href="/templates">Templates</a>. Read the form. Then{' '}
            <a href="/proposals/new">New proposal</a> with that template and a real title.
          </p>
        </section>
        <section className="card" style={{ padding: 'var(--space-5)' }}>
          <h2>2. Fill the packet in order</h2>
          <p>
            Cover page, board letter, the act, then fiscal if the template includes it. Yellow-outlined
            lines are editable. Grey guidance lines tell you what belongs there — they do not print
            unless you ask.
          </p>
        </section>
        <section className="card" style={{ padding: 'var(--space-5)' }}>
          <h2>3. Replace the blanks</h2>
          <p>
            <code>____</code> is a slot. <code>Not Applicable</code> means nobody has written that
            section yet. Leaving either in a circulated copy reads as unfinished work.
          </p>
        </section>
        <section className="card" style={{ padding: 'var(--space-5)' }}>
          <h2>4. Freeze, then export</h2>
          <p>
            A milestone locks the current text so a circulated copy stays still while you keep
            drafting. Export PDF builds the packet through Chromium. If export fails, the error is
            now on the page — do not reload the PDF URL more than a few times; it is rate-limited.
          </p>
        </section>
      </div>
    </>
  );
}
