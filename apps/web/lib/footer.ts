export type FooterGroup = 'board' | 'tools' | 'connect';

export type FooterLink = {
  id: string;
  label: string;
  href: string;
  group: FooterGroup;
};

export const defaultFooterLinks: FooterLink[] = [
  { id: 'home', label: 'Legislative files', href: '/', group: 'board' },
  { id: 'docket', label: 'Legislative docket', href: 'https://app.blevinsholdings.com/', group: 'board' },
  { id: 'meetings', label: 'Meetings', href: '/meetings', group: 'board' },
  { id: 'templates', label: 'Drafting templates', href: '/templates', group: 'board' },
  { id: 'publications', label: 'Publications', href: '/publications', group: 'board' },
  { id: 'corporate', label: 'Blevins Holdings', href: 'https://www.blevinsholdings.com/', group: 'board' },
  { id: 'trust', label: 'Trust center', href: 'https://trust.blevinsholdings.com/', group: 'board' },
  { id: 'help', label: 'Help', href: '/help', group: 'tools' },
  { id: 'settings', label: 'Administration', href: '/settings', group: 'tools' },
  { id: 'terms', label: 'Terms of use', href: '/terms', group: 'tools' },
  { id: 'privacy', label: 'Privacy', href: '/privacy', group: 'tools' },
  { id: 'linking', label: 'Website policies', href: '/linking', group: 'tools' },
  { id: 'accessibility', label: 'Accessibility', href: '/accessibility', group: 'tools' },
  { id: 'sitemap', label: 'Site map', href: '/sitemap', group: 'tools' },
  { id: 'facebook', label: 'Facebook', href: 'https://www.facebook.com/blevinsholdings', group: 'connect' },
  { id: 'linkedin', label: 'LinkedIn', href: 'https://www.linkedin.com/company/blevins', group: 'connect' },
  { id: 'x', label: 'X', href: 'https://x.com/blevinsholdings', group: 'connect' },
  { id: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/blevinsholdings', group: 'connect' },
];
