export function OfficialBanner() {
  return (
    <details className="gov-banner">
      <summary className="gb-bar">
        <img className="gb-logo" src="/brand/seal-on-light.png" alt="" width={20} height={20} />
        <span className="gb-text">
          An official system of the Blevins Holdings Board of Governors
        </span>
        <span className="gb-toggle">Here&rsquo;s how you know</span>
      </summary>
      <div className="gb-body">
        <div className="gb-cols">
          <div className="gb-col">
            <strong>This is the Board&rsquo;s own record</strong>
            <p>
              Instruments drafted here become the official text of the Board. Published copies and
              packets are produced from that text — not from a second system.
            </p>
          </div>
          <div className="gb-col">
            <strong>Secure sites use HTTPS</strong>
            <p>
              A lock or https:// means the connection to this host is encrypted. Sign in only on
              this official host or on app.blevinsholdings.com.
            </p>
          </div>
          <div className="gb-col">
            <strong>Internal use</strong>
            <p>
              Access is limited to authenticated members and staff. Actions that change a file are
              attributed. The live docket and votes remain on app.blevinsholdings.com.
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}
