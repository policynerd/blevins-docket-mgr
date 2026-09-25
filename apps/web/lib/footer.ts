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
  { id: 'drafting', label: 'This system', href: '/', group: 'organization' },
  { id: 'terms', label: 'Terms of use', href: '/terms', group: 'legal' },
  { id: 'privacy', label: 'Privacy', href: '/privacy', group: 'legal' },
  { id: 'accessibility', label: 'Accessibility', href: '/accessibility', group: 'legal' },
  { id: 'linking', label: 'Linking policy', href: '/linking', group: 'legal' },
  { id: 'sitemap', label: 'Site map', href: '/sitemap', group: 'legal' },
  { id: 'help', label: 'Help', href: '/help', group: 'legal' },
];
