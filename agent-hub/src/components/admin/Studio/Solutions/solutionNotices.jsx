import React from 'react';
import Notice from './Notice';

/**
 * The two things every Solution screen needs when the server could not read
 * the whole Solution: one strip shape, and human names for the sections it
 * reports as missing.
 *
 * Both lived inside SolutionControlPanel, which is exactly why the Flow tab
 * had neither — it went on printing "Everything in this project is connected
 * and owned consistently." over a graph the server had just told it was
 * partial. `GET /:id/graph` carries `unavailable[]` and `complete` for both
 * screens; a shared module is the cheap way to stop the third one from
 * repeating the miss.
 */

/**
 * A one-line notice ABOVE a list, about the list as a whole.
 *
 * Not a finding: findings are rows in the list, and a row carries its own
 * icon and its own severity. This is the sentence that says how much the list
 * is worth.
 */
export function Strip({ tone, icon, children, testId }) {
    // Callers still pass the colour variable they always did; it picks the tone.
    const raw = String(tone || '');
    const kind = raw.includes('error') ? 'error' : raw.includes('warning') ? 'warning' : raw.includes('success') ? 'success' : 'info';
    return <Notice tone={kind} icon={icon} testId={testId}>{children}</Notice>;
}

/**
 * `unavailable` carries MACHINE keys on purpose — see buildGraphForProject in
 * server/routes/projects.js: the server refuses to send an English label a
 * Dutch reader would then be shown. This is where they become words.
 *
 * A key with no entry here falls through AS ITSELF rather than being dropped.
 * A section added on the server next year must read as jargon in the strip,
 * never as nothing — silently shortening the list of what could not be read
 * is the same fail-open one layer down.
 */
const SECTION_LABEL = {
    apps: ['solutions.section_apps', 'apps'],
    automations: ['solutions.section_automations', 'automations'],
    webpages: ['solutions.section_webpages', 'pages'],
    datatables: ['solutions.section_datatables', 'tables'],
    agents: ['solutions.section_agents', 'agents'],
    knowledgeBases: ['solutions.section_knowledge_bases', 'knowledge bases'],
    knowledgeSources: ['solutions.section_knowledge_sources', 'knowledge sources'],
    automationExistence: ['solutions.section_automation_existence', 'the check on which automations still exist'],
    all: ['solutions.section_all', 'everything in this Solution'],
    // The overview names five more, because a card tallies things a detail page
    // does not: GET /api/projects/summary reports each of these separately so a
    // gap can be pointed at rather than flattened into "something failed".
    notebooks: ['solutions.section_notebooks', 'notebooks'],
    skills: ['solutions.section_skills', 'skills'],
    documentTemplates: ['solutions.section_document_templates', 'templates'],
    runs: ['solutions.section_runs', 'how often things ran'],
    completeness: ['solutions.section_completeness', 'the checks'],
    update: ['solutions.section_update', 'whether a newer version exists'],
    installedVersions: ['solutions.section_installed_versions', 'which version is installed'],
    blueprints: ['solutions.section_blueprints', 'the Blueprints kept here'],
};

/** The section keys the server named, in the reader's own language. */
export function sectionNames(keys, t) {
    return (Array.isArray(keys) ? keys : [])
        .filter(k => typeof k === 'string' && k)
        .map(k => (SECTION_LABEL[k] ? t(SECTION_LABEL[k][0], SECTION_LABEL[k][1]) : k));
}
