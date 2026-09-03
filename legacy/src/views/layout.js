'use strict';

/*
 * Compatibility wrapper around the established layout module.
 *
 * The production docket manager has a large, well-tested server-rendered layout.
 * Keep that behavior intact and add the institutional design layer after the
 * legacy stylesheet so this redesign can be reviewed and rolled back without
 * rewriting every view at once.
 */
const base = require('./layout-base');

function withInstitutionalCss(markup) {
  const html = String(markup || '');
  const legacy = '<link rel="stylesheet" href="/styles.css">';
  const institutional = legacy + '\n  <link rel="stylesheet" href="/assets/institutional.css">';
  return html.includes('/assets/institutional.css') ? html : html.replace(legacy, institutional);
}

function layout(opts) {
  return withInstitutionalCss(base.layout(opts));
}

function authLayout(title, body) {
  return withInstitutionalCss(base.authLayout(title, body));
}

function forbidden() {
  return withInstitutionalCss(base.forbidden());
}

module.exports = {
  ...base,
  layout,
  authLayout,
  forbidden,
};
