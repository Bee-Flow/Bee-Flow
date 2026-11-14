// @typecheck strict
'use strict';
/**
 * The Firebird connection fields as the settings form sends them, shared by
 * POST /ai/user-settings (saves them) and POST /ai/firebird/test (tries them
 * unsaved). One shape, so a value the test accepts is a value Save accepts.
 *
 * Every field is text; '' (or null) means "not set" / disconnect. The host and
 * the account travel into the connection string, so the shape checks are the
 * guard against a scheme, a path or a separator slipping in. Private and LAN
 * hosts are allowed on purpose: the server runs next to the database.
 */

const { z, typeError } = require('../../../utils/zod');
const { HOST_RE, PORT_RE, DATABASE_RE, USER_RE, PASSWORD_RE, CHARSET_RE } = require('../../../integrations/firebirdTools');

const HOST_TEXT = 'Firebird server is invalid. Use the host name or IP address only, without a scheme, path or spaces.';
const PORT_TEXT = 'Firebird port is a number from 1 to 65535 (leave empty for 3050).';
const DATABASE_TEXT = 'Firebird database is invalid. Use the alias or the file path as the Firebird server sees it.';
const ACCOUNT_TEXT = 'Firebird user is invalid. Use the account name only.';
// nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a validation message, not a credential
const SECRET_TEXT = 'Firebird password is invalid.';
const CHARSET_TEXT = 'Firebird character set is invalid. Use a name such as UTF8, NONE or WIN1252.';

/**
 * Text that must match `re` unless it is '' (not set).
 * @param {RegExp} re
 * @param {string} message
 * @param {boolean} [trim]
 */
const shaped = (re, message, trim = true) => {
    const base = z.string({ error: typeError({ invalid: message }) });
    return (trim ? base.trim() : base).refine((v) => v === '' || re.test(v), message).nullable();
};

/** A port: a number is taken as its digits; '' means the default (3050). */
const port = z.preprocess((v) => (typeof v === 'number' ? String(v) : v),
    z.string({ error: typeError({ invalid: PORT_TEXT }) }).trim()
        .refine((v) => v === '' || (PORT_RE.test(v) && Number(v) >= 1 && Number(v) <= 65535), PORT_TEXT).nullable());

const firebirdFields = {
    firebirdHost: shaped(HOST_RE, HOST_TEXT),
    firebirdPort: port,
    firebirdDatabase: shaped(DATABASE_RE, DATABASE_TEXT),
    firebirdUser: shaped(USER_RE, ACCOUNT_TEXT),
    // The password is kept exactly as typed (no trimming).
    firebirdPassword: shaped(PASSWORD_RE, SECRET_TEXT, false),
    firebirdCharset: shaped(CHARSET_RE, CHARSET_TEXT),
};

module.exports = { firebirdFields };
