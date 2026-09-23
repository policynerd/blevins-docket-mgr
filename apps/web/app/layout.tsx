import type { ReactNode } from 'react';
import { Libre_Baskerville, Source_Sans_3 } from 'next/font/google';

import { SessionBadge } from './session';

import './globals.css';
import './document.css';

const legal = Libre_Baskerville({
  subsets: ['latin'],
  weight: ['400', '700'],
  style: ['normal', 'italic'],
  variable: '--font-text-face',
});

const ui = Source_Sans_3({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  variable: '--font-ui-face',
});

export const metadata = {
  title: {
    default: 'Legislative Drafting — Board of Governors',
    template: '%s — Board of Governors',
  },
  description:
    'Official legislative drafting system of the Blevins Holdings Board of Governors.',
  applicationName: 'Board of Governors Drafting',
  icons: {
    icon: [{ url: '/favicon.svg', type: 'image/svg+xml' }, { url: '/brand/seal.svg' }],
    apple: '/brand/seal.svg',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${legal.variable} ${ui.variable}`}>
      <body>
        <div className="official-banner">
          <img src="/brand/seal.svg" alt="" width={16} height={16} />
          <p>
            An official website of the <strong>Blevins Holdings Board of Governors</strong>.
          </p>
        </div>
        <header className="masthead">
          <a href="/" className="brand">
            <img
              src="/brand/seal.svg"
              alt="Seal of the Board of Governors"
              width={44}
              height={44}
              className="brand-seal"
            />
            <span className="brand-text">
              <span className="org">Blevins Holdings</span>
              <span className="wordmark">Board of Governors</span>
            </span>
          </a>
          <span className="spacer" />
          <nav className="mast-nav" aria-label="Primary">
            <a href="/">Files</a>
            <a href="/meetings">Calendar</a>
            <a href="/templates">Templates</a>
            <a href="/help">How to draft</a>
            <a href="/settings">Settings</a>
          </nav>
          <SessionBadge />
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <div className="footer-brand">
            <img src="/brand/seal.svg" alt="" width={36} height={36} />
            <div>
              <strong>Blevins Holdings Board of Governors</strong>
              <div>Office of the General Counsel · Legislative drafting</div>
            </div>
          </div>
          <nav aria-label="Legal">
            <a href="/terms">Terms of use</a>
            <a href="/privacy">Privacy</a>
            <a href="/accessibility">Accessibility</a>
            <a href="/help">How to draft</a>
          </nav>
        </footer>
      </body>
    </html>
  );
}
