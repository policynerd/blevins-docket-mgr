import type { ReactNode } from 'react';
import { Libre_Baskerville, Source_Sans_3 } from 'next/font/google';

import { OfficialBanner } from './official-banner';
import { SessionBadge } from './session';
import { SiteFooter } from './site-footer';

import './globals.css';
import './footer.css';
import './official.css';
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
    default: 'Legislative Information System — Blevins Holdings',
    template: '%s — Blevins Holdings',
  },
  description:
    'Official legislative information and drafting system of the Blevins Holdings Board of Governors.',
  applicationName: 'Blevins Legislative Information System',
  icons: {
    icon: [{ url: '/brand/seal-on-light.png', type: 'image/png' }, { url: '/favicon.svg', type: 'image/svg+xml' }],
    apple: '/brand/seal-on-light.png',
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${legal.variable} ${ui.variable}`}>
      <body>
        <a className="skip-link" href="#content">
          Skip to main content
        </a>
        <OfficialBanner />
        <header className="masthead">
          <a href="/" className="brand">
            <img
              src="/brand/seal.png"
              alt="Seal of the Board of Governors"
              width={44}
              height={44}
              className="brand-seal"
            />
            <span className="brand-text">
              <span className="org">Blevins Holdings Board of Governors</span>
              <span className="wordmark">Legislative Information System</span>
              <span className="purpose">Official drafting and records of the Board</span>
            </span>
          </a>
          <span className="spacer" />
          <nav className="mast-nav" aria-label="Primary">
            <a href="/">Legislation</a>
            <a href="/docket">Today&apos;s Docket</a>
            <a href="/meetings">Meetings</a>
            <a href="/templates">Drafting</a>
            <a href="/publications">Records</a>
            <a href="/help">Help</a>
            <a href="/settings">Administration</a>
          </nav>
          <SessionBadge />
        </header>
        <main id="content">{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
