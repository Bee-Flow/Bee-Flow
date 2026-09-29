/**
 * Pure view helpers of the Playbook pages — the words a phase or a playbook
 * gets in the list, the rail and the done card. Kept out of the component
 * files so they can be imported by tests (and so Fast Refresh keeps working).
 */
import { kindOf } from './phaseMachine';
import { getItem } from '../../../../utils/scopedStorage';
import { formatElapsed } from '../../../shared/builder/formatElapsed';

export const AUTOPILOT_KEY = 'playbooks.autopilot';

export function readAutopilot() {
    try { return getItem(AUTOPILOT_KEY) === '1'; } catch { return false; }
}

/** The status chip of a playbook in the list: text + colour token. */
export function playbookStatusLabel(pb, t) {
    const phases = Array.isArray(pb?.phases) ? pb.phases : [];
    if (pb?.status === 'done') return { text: t('playbooks.state.done', 'Done'), tone: 'var(--success-ink, var(--success))' };
    if (pb?.status === 'stopped') return { text: t('playbooks.status.stopped', 'Stopped'), tone: 'var(--text-secondary)' };
    if (phases.some((p) => p.status === 'failed')) return { text: t('playbooks.state.failed', 'Failed'), tone: 'var(--error-ink, var(--error))' };
    if (phases.some((p) => p.status === 'running')) return { text: t('playbooks.state.running', 'Building…'), tone: 'var(--type-ai)' };
    if (phases.some((p) => p.status === 'awaiting')) return { text: t('playbooks.state.awaiting', 'Paused for you'), tone: 'var(--text-secondary)' };
    return { text: t('playbooks.state.ready', 'Ready to start'), tone: 'var(--type-ai)' };
}

/** One 11 px fact line per phase, from its artifacts ("Facturen · 32 rows"). */
/**
 * The page's own error codes, in words.
 *
 * HandoffCard has had this table since the beginning; the inspector printed the
 * raw code beside it, so the same failure read as a sentence in one place and as
 * `model_empty_reply` in the other.
 */
const CLIENT_ERRORS = {
    aborted: ['playbooks.err.aborted', 'The builder stopped before it finished.'],
    stopped: ['playbooks.err.stopped', 'The turn was stopped.'],
    model_empty_reply: ['playbooks.err.model_empty_reply', 'The model returned nothing usable — try again.'],
    interrupted: ['playbooks.err.interrupted', 'Stopped mid-build. Retry hands the builder the brief again on what is already there; Mark as done keeps it as it is.'],
    artifacts_missing: ['playbooks.err.artifacts_missing', 'The previous phase produced nothing this one can build on.'],
    app_unreadable: ['playbooks.err.app_unreadable', 'The app could not be opened.'],
};

export function errorText(error, t) {
    if (!error) return '';
    const known = CLIENT_ERRORS[error];
    return known ? t(known[0], known[1]) : String(error);
}

/** A run's wire status as the rail's own vocabulary. */
const RUN_STATE = {
    success: ['playbooks.state.done', 'Done'],
    error: ['playbooks.state.failed', 'Failed'],
    failed: ['playbooks.state.failed', 'Failed'],
    running: ['playbooks.state.running', 'Building…'],
    cancelled: ['playbooks.state.skipped', 'Skipped'],
};

export function phaseFact(phase, t) {
    const a = (phase && phase.artifacts) || {};
    switch (kindOf(phase)) {
        case 'table':
            if (!a.datatableName) return null;
            return Number.isFinite(a.rowCount)
                ? t('playbooks.fact.table_rows', '{name} · {n} rows', { name: a.datatableName, n: a.rowCount })
                : a.datatableName;
        case 'routine':
            return a.automationTitle ? t('playbooks.fact.routine', 'Automation "{name}"', { name: a.automationTitle }) : null;
        case 'fill':
            return Number.isFinite(a.rowCount) ? t('playbooks.fact.fill', '{n} rows', { n: a.rowCount }) : null;
        case 'design':
            return a.designName ? t('playbooks.fact.design', '"{name}" · {n} screens', { name: a.designName, n: a.screenCount || 0 }) : null;
        case 'app':
        case 'app_turn':
            return a.appName ? t('playbooks.fact.app', 'App "{name}"', { name: a.appName }) : null;
        case 'access':
            return a.accessApplied ? t('playbooks.fact.access', 'Access set') : null;
        case 'compliance': {
            const n = Array.isArray(a.findings) ? a.findings.length : null;
            if (n === null) return null;
            return n === 0 ? t('playbooks.fact.compliance_clean', 'Nothing came up') : t('playbooks.fact.compliance', '{n} to look at', { n });
        }
        default:
            return null;
    }
}

/**
 * Everything a phase's artifacts know, as label/value rows — what the
 * inspector shows when a phase in the rail is clicked. Pure, so the panel
 * stays a dumb renderer and the test asserts the facts, not the markup.
 */
export function phaseFacts(phase, t) {
    const a = (phase && phase.artifacts) || {};
    const rows = [];
    const add = (label, value) => {
        if (value === null || value === undefined || value === '') return;
        if (typeof value === 'number' && !Number.isFinite(value)) return;
        rows.push({ label, value: String(value) });
    };
    switch (kindOf(phase)) {
        case 'table':
            add(t('playbooks.done.table', 'Table'), a.datatableName);
            add(t('playbooks.inspect.key', 'Key'), a.datatableKey);
            add(t('playbooks.inspect.rows', 'Rows'), a.rowCount);
            if (a.isMirror) add(t('playbooks.inspect.kind', 'Kind'), t('playbooks.table.mirror', 'Nextcloud mirror'));
            break;
        case 'routine':
            add(t('playbooks.done.routine', 'Automation'), a.automationTitle || a.automationId);
            break;
        case 'fill':
            // The wire value ("success", "error") is not a word a person reads,
            // and it never translated.
            add(t('playbooks.inspect.run', 'Run'), RUN_STATE[a.runStatus] ? t(RUN_STATE[a.runStatus][0], RUN_STATE[a.runStatus][1]) : a.runStatus);
            add(t('playbooks.inspect.rows', 'Rows'), a.rowCount);
            if (Number.isFinite(a.rowCount) && Number.isFinite(a.rowsBefore)) add(t('playbooks.inspect.added', 'Added'), a.rowCount - a.rowsBefore);
            break;
        case 'design':
            add(t('playbooks.phase.design', 'Design'), a.designName);
            add(t('playbooks.inspect.screens', 'Screens'), a.screenCount);
            add(t('playbooks.inspect.elements', 'Elements'), a.elementCount);
            if (a.design && a.design.look) add(t('playbooks.inspect.accent', 'Look'), `${a.design.look.preset} · ${a.design.look.accent}`);
            break;
        case 'app':
        case 'app_turn':
            add(t('playbooks.done.app', 'App'), a.appName || a.appId);
            break;
        case 'access':
            add(t('playbooks.done.app', 'App'), a.appName || a.appId);
            if (a.accessApplied) add(t('playbooks.phase.access', 'Access'), t('playbooks.fact.access', 'Access set'));
            break;
        case 'compliance':
            add(t('playbooks.compliance.frameworks', 'Frameworks'), (a.frameworks || []).join(', '));
            if (Array.isArray(a.findings)) add(t('playbooks.compliance.findings', 'Findings'), a.findings.length);
            break;
        default:
            break;
    }
    return rows;
}

/** Where a phase's artifacts live, for the inspector's doors. */
export function phaseLinks(phase) {
    const a = (phase && phase.artifacts) || {};
    const out = [];
    if (a.datatableId && kindOf(phase) !== 'app' && kindOf(phase) !== 'app_turn') out.push({ kind: 'datatable', to: `studio/datatables/${a.datatableId}` });
    if (a.automationId) out.push({ kind: 'automation', to: `studio/automations/${a.automationId}` });
    if (a.appId) out.push({ kind: 'app', to: `studio/apps/${a.appId}` });
    return out;
}

/** How long a phase took, once it has both stamps. */
export function phaseDuration(phase) {
    const start = Date.parse((phase && phase.startedAt) || '');
    const end = Date.parse((phase && phase.finishedAt) || '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    return formatElapsed(new Date(start).toISOString(), end);
}

/** Total time from the first phase's start to the last landing. */
export function totalElapsed(playbook) {
    const phases = Array.isArray(playbook?.phases) ? playbook.phases : [];
    const starts = phases.map((p) => Date.parse(p.startedAt || '')).filter(Number.isFinite);
    const ends = phases.map((p) => Date.parse(p.finishedAt || '')).filter(Number.isFinite);
    if (!starts.length || !ends.length) return null;
    return formatElapsed(new Date(Math.min(...starts)).toISOString(), Math.max(...ends));
}

/** How long a landing stays on screen under autopilot: longer when there are rows or a design to look at. */
export function autopilotLingerSeconds(phase) {
    const kind = kindOf(phase);
    if (kind === 'fill') return 8;
    if (kind === 'design' || kind === 'table') return 6;
    return 3;
}

