import type { ReactNode } from 'react';
import { CommandMenu } from './command-menu';
import './command-menu.css';

export default function AppTemplate({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <CommandMenu />
    </>
  );
}