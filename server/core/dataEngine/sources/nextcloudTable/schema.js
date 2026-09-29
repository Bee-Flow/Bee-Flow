/**
 * The schema reconciliation is not Nextcloud's: it writes a derived field
 * list into the scope model with the DDL that follows, whoever derived it.
 * It lives in ../mirror/schema.js and is re-exported here so every caller
 * and every test that stubs `./schema` keeps its request string.
 */

'use strict';

module.exports = require('../mirror/schema');
