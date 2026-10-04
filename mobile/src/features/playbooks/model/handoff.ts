/**
 * The pause between phases, as decisions: which face the handoff card shows,
 * what it says about the phase that comes next, and which phases the phone
 * may start on its own.
 *
 * The web runs two phase kinds inside the page — the automation builder
 * (`automation`) and the App Studio builder (`app`, `app_turn`) stream a model
 * turn in the browser tab. The phone has neither builder, so it never starts
 * one of those phases: a phase it cannot finish would sit `running` with
 * nobody at the wheel. It says they are built on a computer — not the web
 * page itself, which a phone's browser is bounced off (Studio is not among
 * the web's phone pages) — and keeps every decision the web offers around
 * them (continue, skip, retry, mark as done once the artifact exists, stop).
 */

import type { TranslateFn } from '@/core/i18n';

import { artStr } from './artifacts';
import { CLIENT_RUN, SERVER_RUN, kindOf } from './phaseMachine';
import { phaseLabel } from './playbookView';
import type { Phase } from './types';

/** Builder phases: the web page runs them, on a computer; the phone says so. */
export const WEB_BUILDERS: ReadonlySet<string> = new Set(['automation', 'app', 'app_turn']);

/** A ready phase the phone starts itself: the server runs it, or (access) the person does, here. */
export function shouldAutoStart(phase: Pick<Phase, 'key' | 'kind' | 'status'> | null | undefined): boolean {
    if (!phase || phase.status !== 'ready') return false;
    const kind = kindOf(phase) ?? '';
    return SERVER_RUN.has(kind) || kind === 'access';
}

export type HandoffFace = 'awaiting' | 'failed' | 'needs_input';

/**
 * Which face the card shows, if any. A builder phase that is running on the
 * phone is always "needs input": nothing here is driving it, so the person
 * decides — mark it done when its artifact exists, or stop.
 */
export function handoffFace(phase: Pick<Phase, 'key' | 'kind' | 'status' | 'needsInput'> | null | undefined, complete: boolean): HandoffFace | null {
    if (!phase || complete) return null;
    if (phase.status === 'failed') return 'failed';
    if (phase.status === 'awaiting') return 'awaiting';
    if (phase.status === 'running' && (phase.needsInput || WEB_BUILDERS.has(kindOf(phase) ?? ''))) return 'needs_input';
    return null;
}

/** "Mark as done": a builder phase whose automation or app already exists. */
export function canMarkDone(phase: Pick<Phase, 'key' | 'kind' | 'artifacts'> | null | undefined): boolean {
    const kind = kindOf(phase);
    if (kind === 'automation') return !!artStr(phase?.artifacts, 'automationId');
    if (kind === 'app' || kind === 'app_turn') return !!artStr(phase?.artifacts, 'appId');
    return false;
}

/** The artifact a "Mark as done" hands back, as the web sends it. */
export function markDoneArtifacts(phase: Pick<Phase, 'key' | 'kind' | 'artifacts'>): Record<string, string | null> {
    return kindOf(phase) === 'automation'
        ? { automationId: artStr(phase.artifacts, 'automationId') }
        : { appId: artStr(phase.artifacts, 'appId') };
}

/** Does the next phase come with a brief the person may read and edit before continuing? */
export function hasEditableBrief(next: Pick<Phase, 'key' | 'kind' | 'brief'> | null | undefined): boolean {
    return !!next && CLIENT_RUN.has(kindOf(next) ?? '') && typeof next.brief === 'string' && next.brief !== '';
}

/** One line about the next phase when there is no brief to show. */
export function nextWords(next: Pick<Phase, 'key' | 'kind' | 'label'>, t: TranslateFn): string {
    const phase = phaseLabel(next, t);
    switch (kindOf(next)) {
        case 'design': return t('playbooks.handoff.next_design', 'Next: {phase} — the AI first designs the app as a designer, before it builds.', { phase });
        case 'fill': return t('playbooks.handoff.next_fill', 'Next: {phase} — the automation runs once so the table has real rows.', { phase });
        case 'table': return t('playbooks.handoff.next_table', 'Next: {phase} — the table is created.', { phase });
        case 'access': return t('playbooks.handoff.next_access', 'Next: {phase} — you decide who may open the app. Nothing is applied until you approve it.', { phase });
        case 'compliance': return t('playbooks.handoff.next_compliance', 'Next: {phase} — what was built is read against the frameworks your organisation has switched on.', { phase });
        case 'automation': return t('playbooks.handoff.next_automation', 'Next: {phase} — the automation builder gets a brief and builds it while you watch.', { phase });
        case 'app':
        case 'app_turn': return t('playbooks.handoff.next_app', 'Next: {phase} — the app builder gets a brief and builds it while you watch.', { phase });
        default: return t('playbooks.handoff.next_plain', 'Next: {phase} — its brief is composed when you continue.', { phase });
    }
}
