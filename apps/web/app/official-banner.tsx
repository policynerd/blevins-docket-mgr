'use client';

import { useState } from 'react';

export function OfficialBanner() {
  const [open, setOpen] = useState(false);

  return (
    <div className="official-banner">
      <div className="official-banner-row">
        <img src="/brand/seal.png" alt="" width={16} height={16} />
        <p>
          An official website of the <strong>Blevins Holdings Board of Governors</strong>.
        </p>
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          Here&apos;s how you know
        </button>
      </div>
      {open ? (
        <div className="official-banner-panel">
          <p>
            <strong>This system is operated by the Office of the General Counsel</strong> for the
            Blevins Holdings Board of Governors. It is not a United States Government website.
          </p>
          <p>
            <strong>Secure sites use HTTPS.</strong> A lock or https:// means the connection to
            this host is encrypted. Sign in only on this official host.
          </p>
        </div>
      ) : null}
    </div>
  );
}
