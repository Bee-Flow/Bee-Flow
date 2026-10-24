// @typecheck
'use strict';

/**
 * The `config` key prefixes of per-organisation (and per-user) policy rows that
 * feature modules own, kept here so stores/user can build the teardown list of
 * a deleted organisation (organizations.orgConfigKeys, eraseProjectTraces)
 * without requiring those feature modules. Each owner imports its prefix from
 * here and still exports it as CONFIG_KEY_PREFIX.
 *
 * Each name ends in CONFIG_KEY_PREFIX on purpose: organizations.configKeys.test.js
 * scans the tree for that spelling and forces every prefix into "torn down
 * with the org" or "deliberately kept".
 */
const INTEGRATION_CACHE_CONFIG_KEY_PREFIX = 'org_integration_cache_';
const AI_CONTEXT_CONFIG_KEY_PREFIX = 'org_ai_context_';
const DOCUMENT_STYLE_CONFIG_KEY_PREFIX = 'org_document_style_';
const TRAINING_GATES_CONFIG_KEY_PREFIX = 'org_training_gates_';
const AI_PARTICIPATION_CONFIG_KEY_PREFIX = 'org_ai_participation_';
const USER_AI_PARTICIPATION_KEY_PREFIX = 'user_ai_participation_'; // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_username -- a config key prefix, not a username

module.exports = {
    INTEGRATION_CACHE_CONFIG_KEY_PREFIX,
    AI_CONTEXT_CONFIG_KEY_PREFIX,
    DOCUMENT_STYLE_CONFIG_KEY_PREFIX,
    TRAINING_GATES_CONFIG_KEY_PREFIX,
    AI_PARTICIPATION_CONFIG_KEY_PREFIX,
    USER_AI_PARTICIPATION_KEY_PREFIX,
};
