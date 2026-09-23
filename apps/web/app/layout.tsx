import type { ReactNode } from 'react';
import { Libre_Baskerville, Source_Sans_3 } from 'next/font/google';

import { SessionBadge } from './session';
import { SiteFooter } from './site-footer';

import './globals.css';
import './footer.css';
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
  description: 'Official legislative information and drafting system of the Blevins Holdings Board of Governors.',
  applicationName: 'Blevins Legislative Information System',
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
          <p>An official system of <strong>Blevins Holdings LLC</strong>.</p>
        </div>
        <header className="masthead">
          <a href="/" className="brand">
            <img src="/brand/seal.svg" alt="Blevins Holdings seal" width={44} height={44} className="brand-seal" />
            <span className="brand-text">
              <span className="org">Blevins Holdings</span>
              <span className="wordmark">Legislative Information System</span>
            </span>
          </a>
          <span className="spacer" />
          <nav className="mast-nav" aria-label="Primary">
            <a href="/">Legislation</a>
            <a href="/docket">Today&apos;s Docket</a>
            <a href="/meetings">Meetings</a>
            <a href="/templates">Drafting</a>
            <a href="/help">Help</a>
            <a href="/settings">Administration</a>
          </nav>
          <SessionBadge />
        </header>
        <main>{children}</main>
        <SiteFooter />
      </body>
    </html>
  );
}
