'use strict';

const core = require('./govern-core');
const admin = require('./govern-admin');

module.exports = Object.assign({}, core, admin);

// Keep /people from dumping every person onto the Governors grid.
try {
  require('./pages').peopleList = require('./people-directory').peopleList;
} catch (_) { /* directory module optional until it lands */ }
