/**
 * FORM ANSWERS — a form that collects its answers in a datatable.
 * See derive.js (pure), provision.js (the table follows the form),
 * write.js (a submission becomes a row), summary.js (the dashboard's numbers).
 */

'use strict';

const derive = require('./derive');
const provision = require('./provision');

module.exports = {
    ...derive,
    ...provision,
    get write() { return require('./write'); },
    get summary() { return require('./summary'); },
};
