import { kindOf } from '../../../shared/kindColors';

/**
 * Tailwind cannot see a class built at runtime, so the kind colours the content
 * rows wear are spelled out here, one literal per kind. The values are the same
 * theme variables `kindColors.js` names; a kind with none stays neutral.
 */

const BAR: Record<string, string> = {
    automation: 'border-l-[var(--type-trigger)]',
    datatable: 'border-l-[var(--type-data)]',
    app: 'border-l-[var(--kind-app)]',
    webpage: 'border-l-[var(--kind-web)]',
    document: 'border-l-[var(--kind-doc)]',
    form: 'border-l-[var(--type-pause)]',
    agent: 'border-l-[var(--type-ai)]',
    skill: 'border-l-[var(--kind-skill)]',
    kb: 'border-l-[var(--kind-kb)]',
    meeting: 'border-l-[var(--kind-meet)]',
    playbook: 'border-l-[var(--kind-playbook)]',
};

const INK: Record<string, string> = {
    automation: 'text-[var(--type-trigger)]',
    datatable: 'text-[var(--type-data)]',
    app: 'text-[var(--kind-app)]',
    webpage: 'text-[var(--kind-web)]',
    document: 'text-[var(--kind-doc)]',
    form: 'text-[var(--type-pause)]',
    agent: 'text-[var(--type-ai)]',
    skill: 'text-[var(--kind-skill)]',
    kb: 'text-[var(--kind-kb)]',
    meeting: 'text-[var(--kind-meet)]',
    playbook: 'text-[var(--kind-playbook)]',
};

const key = (kind: string): string | null => kindOf(kind) as string | null;

/** The left bar of a row of this kind. */
export function kindBarClass(kind: string): string {
    const k = key(kind);
    return (k && BAR[k]) || 'border-l-[var(--text-tertiary)]';
}

/** The icon colour of this kind. */
export function kindInkClass(kind: string): string {
    const k = key(kind);
    return (k && INK[k]) || 'text-[var(--text-tertiary)]';
}
