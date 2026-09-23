export type FooterGroup = 'organization' | 'legal' | 'social';

export type FooterLink = {
  id: string;
  label: string;
  href: string;
  group: FooterGroup;
};

export const FOOTER_KEY = 'blevins-footer-links';

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
  { id: 'linkedin', label: 'LinkedIn', href: '', group: 'social' },
  { id: 'x', label: 'X / Twitter', href: '', group: 'social' },
];

export function loadFooterLinks(): FooterLink[] {
  if (typeof window === 'undefined') return defaultFooterLinks;
  try {
    const raw = localStorage.getItem(FOOTER_KEY);
    if (!raw) return defaultFooterLinks;
    const parsed = JSON.parse(raw) as FooterLink[];
    if (!Array.isArray(parsed) || parsed.length === 0) return defaultFooterLinks;
    return parsed.filter((l) => l && typeof l.label === 'string' && typeof l.href === 'string');
  } catch {
    return defaultFooterLinks;
  }
}

export function saveFooterLinks(links: FooterLink[]) {
  localStorage.setItem(FOOTER_KEY, JSON.stringify(links));
  window.dispatchEvent(new Event('blevins-footer-changed'));
}
