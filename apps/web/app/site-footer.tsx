import { defaultFooterLinks, type FooterLink } from '../lib/footer';

function visible(links: FooterLink[], group: FooterLink['group']) {
  return links.filter((l) => l.group === group && l.href.trim());
}

export function SiteFooter() {
  const links = defaultFooterLinks;
  const org = visible(links, 'organization');
  const legal = visible(links, 'legal');
  const social = visible(links, 'social');

  return (
    <footer className="site-footer">
      <div className="footer-brand">
        <img src="/brand/seal.png" alt="" width={36} height={36} />
        <div>
          <strong>Blevins Holdings Board of Governors</strong>
          <div>Office of the General Counsel · Official legislative drafting system</div>
        </div>
      </div>
      <div className="footer-cols">
        <nav aria-label="Organization">
          <h2>Organization</h2>
          {org.map((l) => (
            <a key={l.id} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        <nav aria-label="Legal">
          <h2>Legal</h2>
          {legal.map((l) => (
            <a key={l.id} href={l.href}>
              {l.label}
            </a>
          ))}
        </nav>
        {social.length ? (
          <nav aria-label="Social">
            <h2>Social</h2>
            {social.map((l) => (
              <a key={l.id} href={l.href} rel="noreferrer" target="_blank">
                {l.label}
              </a>
            ))}
          </nav>
        ) : null}
      </div>
    </footer>
  );
}
