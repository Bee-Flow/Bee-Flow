#!/usr/bin/env node
/**
 * Print a fresh OPAQUE server setup for OPAQUE_SERVER_SETUP.
 *
 * The value is minted by the @serenity-kit/opaque this server runs, so the
 * server can always read it back (auth/opaqueSetup.js checks that at boot and
 * logs one error when it cannot). It goes to stdout with nothing else around
 * it (not even a newline, unless stdout is a terminal), so it can be piped
 * straight into a secret store:
 *
 *   node server/scripts/generate-opaque-setup.js
 *   OPAQUE_SERVER_SETUP="$(node server/scripts/generate-opaque-setup.js)"
 *
 * From inside the server directory or container: node scripts/generate-opaque-setup.js
 *
 * WARNING: the setup is the server's long-term OPAQUE key. CHANGING IT
 * INVALIDATES EVERY EXISTING OPAQUE REGISTRATION: accounts and encryption PINs
 * enrolled through OPAQUE can no longer log in or unlock through OPAQUE and
 * have to enrol again. Set it once per deployment, keep it in the secret
 * store, and share the same value across every replica. Replacing a value the
 * server cannot read loses nothing, since nobody could enrol against it.
 *
 * Treat the output as a secret: do not paste it into tickets, chat or logs.
 */

'use strict';

const opaque = require('@serenity-kit/opaque');

opaque.ready
    .then(() => {
        // No trailing newline into a pipe or file: the library rejects the
        // value with one ("Invalid symbol 10"), which is the very failure
        // this script exists to prevent. A terminal gets one for readability.
        process.stdout.write(opaque.server.createSetup() + (process.stdout.isTTY ? '\n' : ''));
    })
    .catch((err) => {
        process.stderr.write(`Could not generate an OPAQUE server setup: ${err && err.message ? err.message : err}\n`);
        process.exitCode = 1;
    });
