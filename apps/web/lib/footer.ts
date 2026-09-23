/**
 * Official footer. Not editable in the browser.
 * Change links here or via FOOTER_* env on the next settings pass for clerks.
 */
export type FooterGroup = 'organization' | 'legal' | 'social';

export type FooterLink = {
  id: string;
  label: string;
  href: string;
  group: FooterGroup;
};

export const defaultFooterLinks: FooterLink[] = [
  {
    id: 'corporate',
    label: 'Corporate homepage',
    href: 'https://www.blevinsholdings.com',
    group: 'organization',
  },
  {
    id: 'docket',
    label: 'Docket manager',
    href: 'https://beg-docket-manager.fly.dev',
    group: 'organization',
  },
  {
    id: 'drafting',
    label: 'Legislative drafting',
    href: '/',
    group: 'organization',
  },
  { id: 'terms', label: 'Terms of use', href: '/terms', group: 'legal' },
  { id: 'privacy', label: 'Privacy', href: '/privacy', group: 'legal' },
  { id: 'accessibility', label: 'Accessibility', href: '/accessibility', group: 'legal' },
  { id: 'help', label: 'How to draft', href: '/help', group: 'legal' },
];
