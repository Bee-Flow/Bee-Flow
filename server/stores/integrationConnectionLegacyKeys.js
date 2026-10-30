// @typecheck strict
'use strict';

// ── Legacy `config` key ⇄ named-connection mapping ──────────────────
// Each per-user secret key looks like `<prefix>_user_<userId>`. The prefix
// encodes a (provider, field). Multi-field providers (youtrack url+token,
// signrequest subdomain+token) map several prefixes onto ONE connection blob.
/** @type {Record<string, { provider: string, field: string, kind: string }>} */
const LEGACY_KEY_MAP = {
    'fireflies_api_key':     { provider: 'fireflies',   field: 'api_key',      kind: 'api_key' },
    'gamma_api_key':         { provider: 'gamma',       field: 'api_key',      kind: 'api_key' },
    'github_token':          { provider: 'github',      field: 'token',        kind: 'api_key' },
    'youtrack_url':          { provider: 'youtrack',    field: 'url',          kind: 'basic'   },
    'youtrack_token':        { provider: 'youtrack',    field: 'token',        kind: 'basic'   },
    'signrequest_subdomain': { provider: 'signrequest', field: 'subdomain',    kind: 'basic'   },
    'signrequest_token':     { provider: 'signrequest', field: 'token',        kind: 'basic'   },
    'linkedin_access_token': { provider: 'linkedin',    field: 'access_token', kind: 'oauth'   },
    'afas_token':            { provider: 'afas-profit', field: 'token',        kind: 'basic'   },
    'afas_member_number':    { provider: 'afas-profit', field: 'member_number', kind: 'basic'  },
    'afas_env_type':         { provider: 'afas-profit', field: 'env_type',     kind: 'basic'   },
    'nmbrs_api_mode':        { provider: 'nmbrs',       field: 'api_mode',     kind: 'basic'   },
    'nmbrs_subdomain':       { provider: 'nmbrs',       field: 'subdomain',    kind: 'basic'   },
    'nmbrs_email':           { provider: 'nmbrs',       field: 'email',        kind: 'basic'   },
    'nmbrs_token':           { provider: 'nmbrs',       field: 'token',        kind: 'basic'   },
    'nmbrs_env':             { provider: 'nmbrs',       field: 'env',          kind: 'basic'   },
    'vplan_api_key':         { provider: 'vplan',       field: 'api_key',      kind: 'basic'   },
    'vplan_api_env':         { provider: 'vplan',       field: 'api_env',      kind: 'basic'   },
    'firebird_host':         { provider: 'firebird',    field: 'host',         kind: 'basic'   },
    'firebird_port':         { provider: 'firebird',    field: 'port',         kind: 'basic'   },
    'firebird_database':     { provider: 'firebird',    field: 'database',     kind: 'basic'   },
    'firebird_user':         { provider: 'firebird',    field: 'user',         kind: 'basic'   },
    'firebird_password':     { provider: 'firebird',    field: 'password',     kind: 'basic'   },
    'firebird_charset':      { provider: 'firebird',    field: 'charset',      kind: 'basic'   },
    'scaleway_billing_secret_key': { provider: 'scaleway-billing', field: 'secret_key',      kind: 'basic' },
    'scaleway_billing_org_id':     { provider: 'scaleway-billing', field: 'organization_id', kind: 'basic' },
};

module.exports = { LEGACY_KEY_MAP };
