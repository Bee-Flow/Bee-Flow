/**
 * The words a playbook and its phases get on the list, the stage bar, the
 * phase list and the done card — a port of the web's playbookView.js and the
 * phase-word half of recipes.js, pure so the tests read facts, not markup.
 * Keys and English are the web's own (`playbooks.*`, in both dictionaries).
 */

import type { TranslateFn } from '@/core/i18n';
import { formatElapsed } from '@/shared/lib/elapsed';
import type { KindKey } from '@/shared/ui';

import { artNum, artStr, artList } from './artifacts';
import { kindOf } from './phaseMachine';
import type { Phase, PlaybookStatus } from './types';

type Pair = readonly [key: string, en: string];

/** A built-in phase's words, by key and by kind (a custom phase brings its own label). */
export const PHASE_LABEL_KEYS: Readonly<Record<string, Pair>> = Object.freeze({
    table: ['playbooks.phase.table', 'Table'],
    routine: ['playbooks.phase.routine', 'Automation'],
    fill: ['playbooks.phase.fill', 'First rows'],
    design: ['playbooks.phase.design', 'Design'],
    app: ['playbooks.phase.app', 'App'],
    approvals: ['playbooks.phase.approvals', 'Approval flow'],
    app_turn: ['playbooks.phase.app_turn', 'App, next turn'],
    access: ['playbooks.phase.access', 'Access'],
    compliance: ['playbooks.phase.compliance', 'Compliance check'],
});

/** The kind whose tile colour and glyph a phase borrows (the web's PHASE_VISUAL). */
export const PHASE_VISUAL: Readonly<Record<string, KindKey>> = Object.freeze({
    table: 'datatable',
    routine: 'automation',
    fill: 'datatable',
    design: 'app',
    app: 'app',
    app_turn: 'app',
    approvals: 'automation',
    access: 'app',
    compliance: 'compliance',
});

function own<T>(table: Readonly<Record<string, T>>, key: string | null | undefined): T | undefined {
    return key && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

export function phaseKind(phase: Pick<Phase, 'key' | 'kind'> | null | undefined): KindKey {
    if (!phase) return 'playbook';
    return own(PHASE_VISUAL, phase.kind) ?? own(PHASE_VISUAL, phase.key) ?? 'playbook';
}

export function phaseLabel(phase: Pick<Phase, 'key' | 'kind' | 'label'> | null | undefined, t: TranslateFn): string {
    if (!phase) return '';
    if (phase.label) return phase.label;
    const hit = own(PHASE_LABEL_KEYS, phase.key) ?? own(PHASE_LABEL_KEYS, phase.kind);
    return hit ? t(hit[0], hit[1]) : phase.key;
}

export type ViewTone = 'success' | 'neutral' | 'error' | 'ai';

/** The playbook's status chip: words and a tone. */
export function playbookStatus(
    pb: { status: PlaybookStatus; phases: readonly Pick<Phase, 'status'>[] },
    t: TranslateFn,
): { text: string; tone: ViewTone } {
    const phases = pb.phases ?? [];
    if (pb.status === 'done') return { text: t('playbooks.state.done', 'Done'), tone: 'success' };
    if (pb.status === 'stopped') return { text: t('playbooks.status.stopped', 'Stopped'), tone: 'neutral' };
    if (phases.some((p) => p.status === 'failed')) return { text: t('playbooks.state.failed', 'Failed'), tone: 'error' };
    if (phases.some((p) => p.status === 'running')) return { text: t('playbooks.state.running', 'Building…'), tone: 'ai' };
    if (phases.some((p) => p.status === 'awaiting')) return { text: t('playbooks.state.awaiting', 'Paused for you'), tone: 'neutral' };
    return { text: t('playbooks.state.ready', 'Ready to start'), tone: 'ai' };
}

/** The page's own error codes, in words; anything else is the server's sentence. */
const CLIENT_ERRORS: Readonly<Record<string, Pair>> = Object.freeze({
    aborted: ['playbooks.err.aborted', 'The builder stopped before it finished.'],
    stopped: ['playbooks.err.stopped', 'The turn was stopped.'],
    model_empty_reply: ['playbooks.err.model_empty_reply', 'The model returned nothing usable — try again.'],
    interrupted: ['playbooks.err.interrupted', 'Stopped mid-build. Retry hands the builder the brief again on what is already there; Mark as done keeps it as it is.'],
    artifacts_missing: ['playbooks.err.artifacts_missing', 'The previous phase produced nothing this one can build on.'],
    app_unreadable: ['playbooks.err.app_unreadable', 'The app could not be opened.'],
});

export function errorText(error: string | null | undefined, t: TranslateFn): string {
    if (!error) return '';
    const known = own(CLIENT_ERRORS, error);
    return known ? t(known[0], known[1]) : String(error);
}

type FactFn = (a: Phase['artifacts'], t: TranslateFn) => string | null;

function tableFact(a: Phase['artifacts'], t: TranslateFn): string | null {
    const name = artStr(a, 'datatableName');
    if (!name) return null;
    const rows = artNum(a, 'rowCount');
    return rows !== null ? t('playbooks.fact.table_rows', '{name} · {n} rows', { name, n: rows }) : name;
}

function appFact(a: Phase['artifacts'], t: TranslateFn): string | null {
    const name = artStr(a, 'appName');
    return name ? t('playbooks.fact.app', 'App "{name}"', { name }) : null;
}

function complianceFact(a: Phase['artifacts'], t: TranslateFn): string | null {
    const findings = artList(a, 'findings');
    if (!findings) return null;
    return findings.length === 0
        ? t('playbooks.fact.compliance_clean', 'Nothing came up')
        : t('playbooks.fact.compliance', '{n} to look at', { n: findings.length });
}

const FACTS: Readonly<Record<string, FactFn>> = {
    table: tableFact,
    routine: (a, t) => {
        const name = artStr(a, 'automationTitle');
        return name ? t('playbooks.fact.routine', 'Automation "{name}"', { name }) : null;
    },
    fill: (a, t) => {
        const rows = artNum(a, 'rowCount');
        return rows !== null ? t('playbooks.fact.fill', '{n} rows', { n: rows }) : null;
    },
    design: (a, t) => {
        const name = artStr(a, 'designName');
        return name ? t('playbooks.fact.design', '"{name}" · {n} screens', { name, n: artNum(a, 'screenCount') ?? 0 }) : null;
    },
    app: appFact,
    app_turn: appFact,
    access: (a, t) => (a.accessApplied ? t('playbooks.fact.access', 'Access set') : null),
    compliance: complianceFact,
};

/** One short fact per phase, from its artifacts ("Invoices · 32 rows"). */
export function phaseFact(phase: Pick<Phase, 'key' | 'kind' | 'artifacts'>, t: TranslateFn): string | null {
    const fact = own(FACTS, kindOf(phase));
    return fact ? fact(phase.artifacts ?? {}, t) : null;
}

/**
 * Where a phase's artifacts open on the phone. Every one has a native screen,
 * the table included: a web Custom Tab does not carry the app's session.
 */
export interface PhaseLink {
    kind: 'automation' | 'app' | 'datatable';
    href: string;
}

export function phaseLinks(phase: Pick<Phase, 'key' | 'kind' | 'artifacts'>): PhaseLink[] {
    const a = phase.artifacts ?? {};
    const kind = kindOf(phase);
    const out: PhaseLink[] = [];
    const table = artStr(a, 'datatableId');
    const automation = artStr(a, 'automationId');
    const app = artStr(a, 'appId');
    if (table && kind !== 'app' && kind !== 'app_turn') out.push({ kind: 'datatable', href: `/datatables/${encodeURIComponent(table)}` });
    if (automation) out.push({ kind: 'automation', href: `/automations/${encodeURIComponent(automation)}` });
    if (app) out.push({ kind: 'app', href: `/apps/${encodeURIComponent(app)}` });
    return out;
}

/** How long a phase took, once it has both stamps. */
export function phaseDuration(phase: Pick<Phase, 'startedAt' | 'finishedAt'>): string | null {
    const end = Date.parse(phase.finishedAt ?? '');
    if (!Number.isFinite(end) || !phase.startedAt || end < Date.parse(phase.startedAt)) return null;
    return formatElapsed(phase.startedAt, end);
}

/** Total time from the first phase's start to the last landing (the done card's "in 4m 12s"). */
export function totalElapsed(phases: readonly Pick<Phase, 'startedAt' | 'finishedAt'>[]): string | null {
    const starts = phases.map((p) => Date.parse(p.startedAt ?? '')).filter(Number.isFinite);
    const ends = phases.map((p) => Date.parse(p.finishedAt ?? '')).filter(Number.isFinite);
    if (!starts.length || !ends.length) return null;
    return formatElapsed(new Date(Math.min(...starts)).toISOString(), Math.max(...ends));
}
