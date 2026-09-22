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
  title: 'Blevins Holdings — Board of Governors',
  description: 'Legislative drafting and docket management',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${legal.variable} ${ui.variable}`}>
      <body>
        <header className="masthead">
          <a href="/" className="brand">
            <img src="/brand/seal.svg" alt="" width={40} height={40} className="brand-seal" />
            <span className="brand-text">
              <span className="org">Blevins Holdings</span>
              <span className="wordmark">Board of Governors</span>
            </span>
          </a>
          <span className="spacer" />
          <a href="/">Proposals</a>
          <a href="/templates">Templates</a>
          <a href="/help">How to draft</a>
          <a href="/settings">Settings</a>
          <SessionBadge />
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
