import useTranslation from '../../../../hooks/useTranslation';
import { typeGroupOf } from '../flow/nodeTypeColors';
import { nodeDefaultLabel } from '../flow/nodeDefs';

interface Step { id?: unknown; type?: unknown; label?: unknown; name?: unknown }

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

interface Props {
    definition: Record<string, unknown> | null | undefined;
    added: string[];
    changed: string[];
}

/** Family → inset type stripe; static strings so Tailwind sees every class. */
const STRIPE: Record<string, string> = {
    trigger: 'shadow-[inset_3px_0_0_var(--type-trigger)]',
    ai: 'shadow-[inset_3px_0_0_var(--type-ai)]',
    app: 'shadow-[inset_3px_0_0_var(--type-app)]',
    branch: 'shadow-[inset_3px_0_0_var(--type-branch)]',
    loop: 'shadow-[inset_3px_0_0_var(--type-loop)]',
    data: 'shadow-[inset_3px_0_0_var(--type-data)]',
    pause: 'shadow-[inset_3px_0_0_var(--type-pause)]',
    guard: 'shadow-[inset_3px_0_0_var(--type-guard)]',
    end: 'shadow-[inset_3px_0_0_var(--type-end)]',
};

interface MiniCard { id: string; label: string; family: string; mark: 'new' | 'changed' | null; start?: boolean }

function stepCardLabel(s: Step, type: string, id: string): string {
    if (typeof s.label === 'string' && s.label.trim()) return s.label;
    if (typeof s.name === 'string' && s.name.trim()) return s.name;
    return nodeDefaultLabel(type) || type || id;
}

/** The version's steps in order, the start first. */
function miniCards(definition: Props['definition'], added: string[], changed: string[]): MiniCard[] {
    const addedSet = new Set(added);
    const changedSet = new Set(changed);
    const markOf = (id: string): MiniCard['mark'] => (addedSet.has(id) ? 'new' : changedSet.has(id) ? 'changed' : null);
    const steps = Array.isArray(definition?.steps) ? definition!.steps as Step[] : [];
    // The start: the primary trigger, then any extra entry triggers. The
    // field diff names a trigger by its own id.
    const cards: MiniCard[] = [];
    const triggers = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition!.triggers as unknown[] : [])];
    triggers.forEach((tr, i) => {
        if (!isObj(tr)) return;
        const id = typeof tr.id === 'string' && tr.id ? tr.id : `trigger-${i}`;
        const label = typeof tr.label === 'string' && tr.label.trim() ? tr.label : '';
        cards.push({ id, label, family: 'trigger', mark: markOf(id), start: true });
    });
    for (const s of steps) {
        if (!s || typeof s.id !== 'string') continue;
        const type = typeof s.type === 'string' ? s.type : '';
        if (type === 'note') continue; // a sticky note is not a step
        cards.push({ id: s.id, label: stepCardLabel(s, type, s.id), family: typeGroupOf(type) ?? '', mark: markOf(s.id) });
    }
    return cards;
}

/**
 * A 150px strip of the version's steps: changed steps ringed in warning, new
 * ones in success, the rest dimmed, so the eye lands on what differs.
 *
 * The steps wrap onto a second row rather than scroll sideways, so every
 * change stays in view. Under 900px of its own width the cards are a little
 * narrower and closer together; the strip grows only when a row is full.
 */
export default function VersionMiniCanvas({ definition, added, changed }: Props) {
    const { t } = useTranslation();
    const cards = miniCards(definition, added, changed);
    const anyMark = cards.some((c) => c.mark);
    return (
        <div
            data-testid="version-mini-canvas"
            className="@container/minicanvas shrink-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] bg-[radial-gradient(var(--border-default)_1px,transparent_1px)] bg-[length:14px_14px]"
        >
            <ol className="min-h-[148px] flex flex-wrap items-center content-center justify-center gap-x-4 gap-y-5 px-5 py-6 text-[12px] @[900px]/minicanvas:gap-x-7 @[900px]/minicanvas:px-6">
                {cards.map((c) => (
                    <li
                        key={c.id}
                        data-mark={c.mark ?? undefined}
                        className={`relative w-[124px] @[900px]/minicanvas:w-[150px] h-12 shrink-0 rounded-[10px] bg-[var(--bg-card)] flex items-center px-3 ${STRIPE[c.family] ?? ''} ${
                            c.mark === 'changed' ? 'border-2 border-[var(--warning)] font-semibold'
                                : c.mark === 'new' ? 'border-2 border-[var(--success)] font-semibold'
                                    : `border border-[var(--border-default)] ${anyMark ? 'opacity-55' : ''}`}`}
                    >
                        <span className="truncate text-[var(--text-primary)]" title={c.label || undefined}>
                            {c.start && !c.label ? t('routines.versions.start', 'Start') : c.label}
                        </span>
                        {c.mark && (
                            <span className={`absolute -top-[9px] right-2 px-1.5 rounded-full text-white text-[10px] font-bold ${
                                c.mark === 'new' ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'}`}
                            >
                                {c.mark === 'new' ? t('routines.versions.badge.new', 'new') : t('routines.versions.badge.changed', 'changed')}
                            </span>
                        )}
                    </li>
                ))}
            </ol>
        </div>
    );
}
