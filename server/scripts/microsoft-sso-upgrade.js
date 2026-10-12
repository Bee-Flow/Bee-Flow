#!/usr/bin/env node
'use strict';

// Read-only unless --apply is explicitly supplied. Output contains opaque IDs
// and configuration presence, never client secrets or tokens.
require('dotenv').config({ quiet: true });
const { inspectUpgrade } = require('../migrations/microsoft-sso-hardening-2026-10');
inspectUpgrade({ apply: process.argv.includes('--apply') })
    .then(report => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch(err => { console.error('Microsoft SSO upgrade failed:', err.message); process.exitCode = 1; })
    .finally(async () => { await require('../db').pool.end(); });
