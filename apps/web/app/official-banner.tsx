'use client';

import { useId, useState } from 'react';

function LockIcon({ titleId, descId }: { titleId: string; descId: string }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={13} height={16} viewBox="0 0 52 64" role="img" aria-labelledby={titleId} focusable="false">
      <title id={titleId}>Lock</title>
      <desc id={descId}>Locked padlock</desc>
      <path fill="#000" fillRule="evenodd" d="M26 0c10.493 0 19 8.507 19 19v9h3a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H4a4 4 0 0 1-4-4V32a4 4 0 0 1 4-4h3v-9C7 8.507 15.507 0 26 0zm0 8c-5.979 0-10.843 4.77-10.996 10.712L15 19v9h22v-9c0-6.075-4.925-11-11-11z" />
    </svg>
  );
}

export function OfficialBanner() {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <div className="custom-banner">
      <div className="custom-banner__header">
        <div className="custom-banner__left">
          <img className="custom-banner__flag" src="/brand/seal-on-light.png" width={20} height={20} alt="" />
          <p className="custom-banner__text">An official website of the Blevins Holdings Board of Governors</p>
        </div>
        <button
          type="button"
          className="custom-banner__button"
          aria-expanded={open}
          aria-controls={`banner-content-${id}`}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="custom-banner__button-text">Here&rsquo;s how you know</span>
          <span className={open ? 'custom-banner__caret open' : 'custom-banner__caret'} aria-hidden>
            ▾
          </span>
        </button>
      </div>
      {open ? (
        <div className="custom-banner__content active" id={`banner-content-${id}`}>
          <div className="custom-banner__info">
            <div className="info-block">
              <img src="/brand/seal-on-light.png" width={40} height={40} alt="" />
              <p>
                <strong>Official websites use this host</strong>
                <br />
                This system is operated for the Board of Governors. It is not a United States
                Government website and it is not a .gov.
              </p>
            </div>
            <div className="info-block">
              <span className="icon-lock">
                <LockIcon titleId={`banner-lock-title-${id}`} descId={`banner-lock-desc-${id}`} />
              </span>
              <p>
                <strong>Secure websites use HTTPS</strong>
                <br />
                A <strong>lock</strong> ({' '}
                <span className="icon-lock inline">
                  <LockIcon titleId={`banner-lock-title-2-${id}`} descId={`banner-lock-desc-2-${id}`} />
                </span>
                ) or <strong>https://</strong> means you&rsquo;ve safely connected to this official
                host. Sign in only here or on app.blevinsholdings.com.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
