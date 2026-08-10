import type { ReactNode } from 'react';

import './globals.css';
import './document.css';

export const metadata = {
  title: 'Blevins Holdings — Board of Governors',
  description: 'Legislative drafting and docket management',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <a href="/">
            <span className="org">Blevins Holdings</span>
            <span className="wordmark">Board of Governors</span>
          </a>
          <span className="spacer" />
          <a href="/">Proposals</a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
