// @typecheck strict
'use strict';
/**
 * English GUI String Defaults — the canonical catalogue of every translatable
 * frontend string, the fallback for any locale that does not override a key.
 *
 * One file per namespace (the part of a key before the first "."), so two
 * branches adding keys to different namespaces never touch the same file.
 * A key filed under the wrong namespace, a key defined twice, and a file whose
 * name is not a namespace name all THROW at require time rather than silently
 * vanish.
 *
 * The namespace files are read from the TREE, not from this directory alone:
 * tree path i18n/defaults/en/ joined over every root (server/ and each
 * modules/<id>/server/, see server/moduleRoots.cjs), so a module that owns a
 * namespace keeps its file in its own root. A namespace whose file is absent
 * (its module is not installed, or hidden in core mode) is skipped.
 *
 * Adding a namespace: create <namespace>.js (copy the header of any sibling)
 * and nothing else. Files not in NAMESPACES below are found by listing the
 * tree directory and merged after the listed ones, in file-name order, so two
 * branches that each add a namespace touch no shared file (the generated
 * frontend copy is regenerated after the merge). After any change here,
 * regenerate the frontend copy: `node scripts/gen-i18n-defaults.mjs`.
 *
 * NAMESPACES is the order of the namespaces that existed before discovery: it
 * fixes their position in GUI_DEFAULTS, and so the bytes of the generated
 * copy. Do not add new namespaces to it, and do not reorder it.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listTreeDir } = require('../../../moduleRoots.cjs');
const { isNamespaceName } = require('../namespaceName.js');

/** Tree path of the English namespace files. */
const EN_TREE_DIR = 'i18n/defaults/en';

const NAMESPACES = Object.freeze([
    "appearance", "nc_onboarding", "init_setup", "activity", "adoption", "admin", "agent",
    "agent_schedules", "agent_skills", "agent_studio", "agent_usage", "agent_wizard",
    "ai_step_checks", "app", "app_studio", "approvals", "apps", "azure", "billing", "changepw",
    "chat", "chat_monitoring", "checkout", "cms_blog", "cms_site", "cms_redirects", "cms_share",
    "code_step", "comments", "common", "compliance", "condition_node", "connections", "consent",
    "contacts", "cowork", "crm", "datatables", "dlp", "documents", "dsr_public", "editor",
    "egress_map", "encryption", "error", "flatten_node", "forms", "greet", "handover", "http_query",
    "integ", "kb_studio", "knowledge", "languages", "learn", "license", "login", "maintenance",
    "managed_part", "mcp_access", "mcp_library", "meeting_notes", "meetings", "mfa", "modules",
    "nc_scope", "nc_trigger_scope", "notebooks", "notification", "notifications", "org", "pii",
    "playbooks", "privacy", "project_collab", "project_chat", "project_content", "project_home",
    "project_participation", "project_tasks", "projects", "reset", "automationAgentBindings",
    "automation_editor", "automation_tables", "automation_run_checks", "automation_testing",
    "automations", "run_status", "runs", "security_studio", "settings", "shield_activity",
    "shield_checks", "shield_data", "shield_look", "shield_overview", "shield_shell", "sidebar",
    "signup", "skill_form", "skills", "skills_studio", "solution_stages", "solutions",
    "stage_settings", "spreadsheet", "starter", "store", "studio", "suggestions", "support",
    "tasks", "teams_setup", "templates", "tests_studio", "tier", "time", "tour", "training",
    "usage", "vault", "versions", "visibility", "voiceprint", "webpages", "admin_ai_config",
    "admin_languages", "admin_monitoring", "admin_org", "admin_security", "admin_shared",
    "admin_subscriptions", "studio_apps_bi", "studio_apps_edit", "studio_apps_tables",
    "studio_apps_insp", "studio_apps_panels", "studio_apps_runtime", "studio_apps_runs",
    "studio_apps_validate", "studio_app_documents", "studio_misc",
]);

/** @typedef {{ name: string, abs: string, moduleId?: string | null }} NamespaceFileEntry */

/**
 * @param {NamespaceFileEntry} a
 * @param {NamespaceFileEntry} b
 */
function byName(a, b) {
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * The namespace files among `entries`, in file-name order. A `.js` file whose
 * name is not a namespace name throws: it would otherwise be skipped, and its
 * keys lost.
 * @param {NamespaceFileEntry[]} entries the entries of one directory, or of the tree directory over all roots
 * @returns {Map<string, string>} namespace -> absolute path of its file
 */
function namespaceFiles(entries) {
    /** @type {Map<string, string>} */
    const files = new Map();
    for (const entry of [...entries].sort(byName)) {
        const file = entry.name;
        if (!file.endsWith('.js') || file === 'index.js') continue;
        const ns = file.slice(0, -'.js'.length);
        if (!isNamespaceName(ns)) {
            const where = entry.moduleId ? `i18n/defaults/en/ of module "${entry.moduleId}"` : 'server/i18n/defaults/en/';
            throw new Error(`i18n: ${file} in ${where} is not a namespace file (name it <namespace>.js: letters, digits, underscores)`);
        }
        files.set(ns, entry.abs);
    }
    return files;
}

/**
 * The namespace files in `dir` that NAMESPACES does not list, in file-name
 * order. A `.js` file whose name is not a namespace name throws.
 * @param {string} dir
 * @param {Set<string>} listed namespace names already in NAMESPACES
 * @returns {string[]}
 */
function discoverNamespaces(dir, listed) {
    const entries = fs.readdirSync(dir).map((name) => ({ name, abs: path.join(dir, name) }));
    return [...namespaceFiles(entries).keys()].filter((ns) => !listed.has(ns));
}

/** Every namespace file of the tree: namespace -> absolute path. */
const FILES = namespaceFiles(listTreeDir(EN_TREE_DIR));
const PINNED = new Set(NAMESPACES);

/** The pinned namespaces whose file is present, in pinned order. */
const LISTED_NAMESPACES = Object.freeze(NAMESPACES.filter((ns) => FILES.has(ns)));
/** The pinned namespaces whose file is absent (module not installed, or hidden): skipped. */
const SKIPPED_NAMESPACES = Object.freeze(NAMESPACES.filter((ns) => !FILES.has(ns)));
/** The present namespaces NAMESPACES does not list, in file-name order. */
const DISCOVERED_NAMESPACES = Object.freeze([...FILES.keys()].filter((ns) => !PINNED.has(ns)));

/** @returns {Record<string, Record<string, string>>} every present namespace: the listed ones first, then the discovered ones */
function allNamespaces() {
    /** @type {Record<string, Record<string, string>>} */
    const all = {};
    for (const ns of [...LISTED_NAMESPACES, ...DISCOVERED_NAMESPACES]) {
        all[ns] = require(/** @type {string} */ (FILES.get(ns)));
    }
    return all;
}

function build() {
    /** @type {Record<string, string>} */
    const merged = {};
    for (const [ns, entries] of Object.entries(allNamespaces())) {
        for (const [key, value] of Object.entries(entries)) {
            const keyNs = key.split('.')[0];
            if (keyNs !== ns) {
                throw new Error(`i18n: key "${key}" is in en/${ns}.js but its namespace is "${keyNs}" — move it to en/${keyNs}.js`);
            }
            if (Object.prototype.hasOwnProperty.call(merged, key)) {
                throw new Error(`i18n: key "${key}" is defined more than once in server/i18n/defaults/en/`);
            }
            merged[key] = value;
        }
    }
    return merged;
}

const GUI_DEFAULTS = build();

// Get all namespace categories for the GUI editor filter
function getGUINamespaces() {
    const namespaces = new Set();
    for (const key of Object.keys(GUI_DEFAULTS)) {
        const ns = key.split('.')[0];
        namespaces.add(ns);
    }
    return Array.from(namespaces).sort();
}

module.exports = {
    GUI_DEFAULTS,
    getGUINamespaces,
    discoverNamespaces,
    namespaceFiles,
    NAMESPACES,
    LISTED_NAMESPACES,
    SKIPPED_NAMESPACES,
    DISCOVERED_NAMESPACES,
};
