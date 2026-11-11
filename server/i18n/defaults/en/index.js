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
 * Adding a namespace: create ./<namespace>.js (copy the header of any sibling)
 * and nothing else. Files not in NAMESPACES below are found by reading this
 * directory and merged after the listed ones, in file-name order, so two
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
const { isNamespaceName } = require('../namespaceName.js');

const NAMESPACES = {
    "appearance":      require('./appearance.js'),
    "nc_onboarding":   require('./nc_onboarding.js'),
    "init_setup":      require('./init_setup.js'),
    "activity":        require('./activity.js'),
    "adoption":        require('./adoption.js'),
    "admin":           require('./admin.js'),
    "agent":           require('./agent.js'),
    "agent_schedules": require('./agent_schedules.js'),
    "agent_skills":    require('./agent_skills.js'),
    "agent_studio":    require('./agent_studio.js'),
    "agent_usage":     require('./agent_usage.js'),
    "agent_wizard":    require('./agent_wizard.js'),
    "ai_step_checks":  require('./ai_step_checks.js'),
    "app":             require('./app.js'),
    "app_studio":      require('./app_studio.js'),
    "approvals":       require('./approvals.js'),
    "apps":            require('./apps.js'),
    "azure":           require('./azure.js'),
    "billing":         require('./billing.js'),
    "changepw":        require('./changepw.js'),
    "chat":            require('./chat.js'),
    "chat_monitoring": require('./chat_monitoring.js'),
    "checkout":        require('./checkout.js'),
    "cms_blog":        require('./cms_blog.js'),
    "cms_site":         require('./cms_site.js'),
    "cms_redirects":    require('./cms_redirects.js'),
    "cms_share":        require('./cms_share.js'),
    "code_step":       require('./code_step.js'),
    "comments":        require('./comments.js'),
    "common":          require('./common.js'),
    "compliance":      require('./compliance.js'),
    "condition_node":  require('./condition_node.js'),
    "connections":     require('./connections.js'),
    "consent":         require('./consent.js'),
    "contacts":        require('./contacts.js'),
    "cowork":          require('./cowork.js'),
    "crm":             require('./crm.js'),
    "datatables":      require('./datatables.js'),
    "dlp":             require('./dlp.js'),
    "documents":       require('./documents.js'),
    "dsr_public":      require('./dsr_public.js'),
    "editor":          require('./editor.js'),
    "egress_map":      require('./egress_map.js'),
    "encryption":      require('./encryption.js'),
    "error":           require('./error.js'),
    "flatten_node":    require('./flatten_node.js'),
    "forms":           require('./forms.js'),
    "greet":           require('./greet.js'),
    "handover":        require('./handover.js'),
    "http_query":      require('./http_query.js'),
    "integ":           require('./integ.js'),
    "kb_studio":       require('./kb_studio.js'),
    "knowledge":       require('./knowledge.js'),
    "languages":       require('./languages.js'),
    "learn":           require('./learn.js'),
    "license":         require('./license.js'),
    "login":           require('./login.js'),
    "maintenance":     require('./maintenance.js'),
    "managed_part":    require('./managed_part.js'),
    "mcp_access":      require('./mcp_access.js'),
    "mcp_library":     require('./mcp_library.js'),
    "meeting_notes":   require('./meeting_notes.js'),
    "meetings":        require('./meetings.js'),
    "mfa":             require('./mfa.js'),
    "modules":         require('./modules.js'),
    "nc_scope":        require('./nc_scope.js'),
    "nc_trigger_scope": require('./nc_trigger_scope.js'),
    "notebooks":       require('./notebooks.js'),
    "notification":    require('./notification.js'),
    "notifications":   require('./notifications.js'),
    "org":             require('./org.js'),
    "pii":             require('./pii.js'),
    "playbooks":       require('./playbooks.js'),
    "privacy":         require('./privacy.js'),
    "project_collab":  require('./project_collab.js'),
    "project_chat":    require('./project_chat.js'),
    "project_content": require('./project_content.js'),
    "project_home":    require('./project_home.js'),
    "project_participation": require('./project_participation.js'),
    "project_tasks":   require('./project_tasks.js'),
    "projects":        require('./projects.js'),
    "reset":           require('./reset.js'),
    "automationAgentBindings": require('./automationAgentBindings.js'),
    "automation_editor":  require('./automation_editor.js'),
    "automation_tables":  require('./automation_tables.js'),
    "automation_run_checks": require('./automation_run_checks.js'),
    "automation_testing": require('./automation_testing.js'),
    "automations":        require('./automations.js'),
    "run_status":      require('./run_status.js'),
    "runs":            require('./runs.js'),
    "security_studio": require('./security_studio.js'),
    "settings":        require('./settings.js'),
    "shield_activity": require('./shield_activity.js'),
    "shield_checks":   require('./shield_checks.js'),
    "shield_data":     require('./shield_data.js'),
    "shield_look":     require('./shield_look.js'),
    "shield_overview": require('./shield_overview.js'),
    "shield_shell":    require('./shield_shell.js'),
    "sidebar":         require('./sidebar.js'),
    "signup":          require('./signup.js'),
    "skill_form":      require('./skill_form.js'),
    "skills":          require('./skills.js'),
    "skills_studio":   require('./skills_studio.js'),
    "solution_stages": require('./solution_stages.js'),
    "solutions":       require('./solutions.js'),
    "stage_settings":  require('./stage_settings.js'),
    "spreadsheet":     require('./spreadsheet.js'),
    "starter":         require('./starter.js'),
    "store":           require('./store.js'),
    "studio":          require('./studio.js'),
    "suggestions":     require('./suggestions.js'),
    "support":         require('./support.js'),
    "tasks":           require('./tasks.js'),
    "teams_setup":     require('./teams_setup.js'),
    "templates":       require('./templates.js'),
    "tests_studio":    require('./tests_studio.js'),
    "tier":            require('./tier.js'),
    "time":            require('./time.js'),
    "tour":            require('./tour.js'),
    "training":        require('./training.js'),
    "usage":           require('./usage.js'),
    "vault":           require('./vault.js'),
    "versions":        require('./versions.js'),
    "visibility":      require('./visibility.js'),
    "voiceprint":      require('./voiceprint.js'),
    "webpages":        require('./webpages.js'),
    "admin_ai_config": require('./admin_ai_config.js'),
    "admin_languages": require('./admin_languages.js'),
    "admin_monitoring": require('./admin_monitoring.js'),
    "admin_org": require('./admin_org.js'),
    "admin_security": require('./admin_security.js'),
    "admin_shared": require('./admin_shared.js'),
    "admin_subscriptions": require('./admin_subscriptions.js'),
    "studio_apps_bi": require('./studio_apps_bi.js'),
    "studio_apps_edit": require('./studio_apps_edit.js'),
    "studio_apps_tables": require('./studio_apps_tables.js'),
    "studio_apps_insp": require('./studio_apps_insp.js'),
    "studio_apps_panels": require('./studio_apps_panels.js'),
    "studio_apps_runtime": require('./studio_apps_runtime.js'),
    "studio_apps_runs": require('./studio_apps_runs.js'),
    "studio_apps_validate": require("./studio_apps_validate.js"),
    "studio_app_documents": require('./studio_app_documents.js'),
    "studio_misc": require('./studio_misc.js'),
};

/**
 * The namespace files in `dir` that NAMESPACES does not list, in file-name
 * order. A `.js` file whose name is not a namespace name throws: it would
 * otherwise be skipped, and its keys lost.
 * @param {string} dir
 * @param {Set<string>} listed namespace names already in NAMESPACES
 * @returns {string[]}
 */
function discoverNamespaces(dir, listed) {
    const found = [];
    for (const file of fs.readdirSync(dir).sort()) {
        if (!file.endsWith('.js') || file === 'index.js') continue;
        const ns = file.slice(0, -'.js'.length);
        if (!isNamespaceName(ns)) {
            throw new Error(`i18n: ${file} in server/i18n/defaults/en/ is not a namespace file (name it <namespace>.js: letters, digits, underscores)`);
        }
        if (!listed.has(ns)) found.push(ns);
    }
    return found;
}

const LISTED_NAMESPACES = Object.freeze(Object.keys(NAMESPACES));
const DISCOVERED_NAMESPACES = Object.freeze(discoverNamespaces(__dirname, new Set(LISTED_NAMESPACES)));

/** @returns {Record<string, Record<string, string>>} every namespace: the listed ones first, then the discovered ones */
function allNamespaces() {
    /** @type {Record<string, Record<string, string>>} */
    const all = { ...NAMESPACES };
    for (const ns of DISCOVERED_NAMESPACES) {
        all[ns] = require(path.join(__dirname, `${ns}.js`));
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
    LISTED_NAMESPACES,
    DISCOVERED_NAMESPACES,
};
