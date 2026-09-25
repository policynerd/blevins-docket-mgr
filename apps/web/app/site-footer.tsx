import { defaultFooterLinks, type FooterLink } from '../lib/footer';

function group(links: FooterLink[], name: FooterLink['group']) {
  return links.filter((l) => l.group === name && l.href.trim());
}

export function SiteFooter() {
  const links = defaultFooterLinks;
  const board = group(links, 'board');
  const tools = group(links, 'tools');

  return (
    <footer className="container footer">
      <div className="footer__content">
        <div className="footer__col">
          <h6 className="footer__heading">
            <span className="text-uppercase">Board of Governors</span> <em>of</em>{' '}
            <span className="text-uppercase">Blevins Holdings</span>
          </h6>
          <ul className="list-unstyled">
            {board.map((l) => (
              <li className="footer__listItem" key={l.id}>
                <a className="footer__link" href={l.href}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="footer__col">
          <h6 className="text-uppercase footer__heading">Tools and Information</h6>
          <ul className="list-unstyled">
            {tools.map((l) => (
              <li className="footer__listItem" key={l.id}>
                <a className="footer__link" href={l.href}>
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
        <div className="footer__col">
          <h6 className="text-uppercase footer__heading">Stay Connected</h6>
          <p className="footer__note">
            The public legislative docket is{' '}
            <a className="footer__link" href="https://app.blevinsholdings.com/">
              app.blevinsholdings.com
            </a>
            . Corporate information is on{' '}
            <a className="footer__link" href="https://www.blevinsholdings.com/">
              blevinsholdings.com
            </a>
            .
          </p>
        </div>
      </div>
      <div className="footer__footer">
        <p className="text-uppercase footer__text footer__text--left">
          Board of Governors <em>of</em> Blevins Holdings
        </p>
        <p className="footer__text footer__text--right">Office of the General Counsel</p>
      </div>
    </footer>
  );
}
