'use strict';
/**
 * English GUI String Defaults — the canonical catalogue of every translatable
 * frontend string, the fallback for any locale that does not override a key.
 *
 * One file per namespace (the part of a key before the first "."), so two
 * branches adding keys to different namespaces never touch the same file.
 * Every namespace file is listed below explicitly; a file in this directory
 * that is NOT listed, a key filed under the wrong namespace, and a key defined
 * twice all THROW at require time rather than silently vanish.
 *
 * Adding a namespace: create ./<namespace>.js (copy the header of any sibling)
 * and add it to NAMESPACES. After any change here, regenerate the frontend
 * copy: `node scripts/gen-i18n-defaults.mjs`.
 *
 * First written by scripts/i18n-split.mjs, which rewrites this file from the
 * namespace files present whenever it runs — so a hand edit is fine, as long
 * as it only adds or removes NAMESPACES entries.
 */

const fs = require('node:fs');

const NAMESPACES = {
    "activity":        require('./activity.js'),
    "admin":           require('./admin.js'),
    "agent":           require('./agent.js'),
    "agent_schedules": require('./agent_schedules.js'),
    "agent_skills":    require('./agent_skills.js'),
    "agent_studio":    require('./agent_studio.js'),
    "agent_usage":     require('./agent_usage.js'),
    "agent_wizard":    require('./agent_wizard.js'),
    "app":             require('./app.js'),
    "app_studio":      require('./app_studio.js'),
    "approvals":       require('./approvals.js'),
    "apps":            require('./apps.js'),
    "azure":           require('./azure.js'),
    "billing":         require('./billing.js'),
    "changepw":        require('./changepw.js'),
    "chat":            require('./chat.js'),
    "checkout":        require('./checkout.js'),
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
    "forms":           require('./forms.js'),
    "greet":           require('./greet.js'),
    "integ":           require('./integ.js'),
    "kb_studio":       require('./kb_studio.js'),
    "knowledge":       require('./knowledge.js'),
    "languages":       require('./languages.js'),
    "learn":           require('./learn.js'),
    "license":         require('./license.js'),
    "login":           require('./login.js'),
    "maintenance":     require('./maintenance.js'),
    "managed_part":    require('./managed_part.js'),
    "mcp_library":     require('./mcp_library.js'),
    "meeting_notes":   require('./meeting_notes.js'),
    "meetings":        require('./meetings.js'),
    "mfa":             require('./mfa.js'),
    "modules":         require('./modules.js'),
    "nc_scope":        require('./nc_scope.js'),
    "notebooks":       require('./notebooks.js'),
    "notification":    require('./notification.js'),
    "notifications":   require('./notifications.js'),
    "org":             require('./org.js'),
    "pii":             require('./pii.js'),
    "playbooks":       require('./playbooks.js'),
    "privacy":         require('./privacy.js'),
    "project_chat":    require('./project_chat.js'),
    "project_content": require('./project_content.js'),
    "project_home":    require('./project_home.js'),
    "project_participation": require('./project_participation.js'),
    "project_tasks":   require('./project_tasks.js'),
    "projects":        require('./projects.js'),
    "reset":           require('./reset.js'),
    "automation_editor":  require('./automation_editor.js'),
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
    "support":         require('./support.js'),
    "tasks":           require('./tasks.js'),
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
};

function build() {
    const merged = {};
    for (const [ns, entries] of Object.entries(NAMESPACES)) {
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
    const listed = new Set(Object.keys(NAMESPACES).map((ns) => `${ns}.js`));
    const unlisted = fs.readdirSync(__dirname)
        .filter((f) => f.endsWith('.js') && f !== 'index.js' && !listed.has(f));
    if (unlisted.length) {
        throw new Error(`i18n: ${unlisted.join(', ')} in server/i18n/defaults/en/ is not listed in NAMESPACES (index.js) — its keys would be lost`);
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
};
