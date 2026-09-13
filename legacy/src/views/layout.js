'use strict';

const base = require('./layout-base');

function withInstitutionalCss(markup) {
  let html = String(markup || '');
  const legacy = '<link rel=