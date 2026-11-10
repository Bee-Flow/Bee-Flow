import { Circle, CircleCheck, CircleDashed, CircleX } from 'lucide-react';
import type { useTranslation } from '@/hooks/useTranslation';
import type { Readiness } from '@/api/queries/automation/readiness';
import type { AiActCheckResult } from '@/api/queries/automation/aiActCheck';
import { aiActVisible } from './AiActSection';

// The "Ready to activate?" checklist as a list and as rows, shared by the
// Settings rail (ReadinessRail) and the go-live dialog (header/GoLiveDialog),
// so both say the same thing about the same automation.

type T = ReturnType<typeof useTranslation>['t'];
type State = 'ok' | 'todo' | 'failed' | 'optional';

const ICON: Record<State, { Icon: typeof Circle; tone: string }> = {
    ok: { Icon: CircleCheck, tone: 'text-[var(--success)]' },
    todo: { Icon: CircleDashed, tone: 'text-[var(--warning)]' },
    failed: { Icon: CircleX, tone: 'text-[var(--error)]' },
    optional: { Icon: Circle, tone: 'text-[var(--text-tertiary)]' },
};


/** "11 min ago", in words the catalogue can translate. */
export function agoText(iso: string | null, t: T, now = Date.now()): string {
    if (!iso) return '';
    const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
    if (minutes < 1) return t('automations.ready.ago_now', 'just now');
    if (minutes < 60) return t('automations.ready.ago_min', '{n} min ago', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('automations.ready.ago_hours', '{n} h ago', { n: hours });
    return t('automations.ready.ago_days', '{n} days ago', { n: Math.floor(hours / 24) });
}

export interface ReadinessItem { key: string; state: State; label: string; section?: string }

/**
 * The AI Act row: Bee's own check when it has answered (it may have recorded
 * the check a moment ago, or found a question since), else the checklist.
 */
function aiActState(r: Readiness, check: AiActCheckResult | undefined): State {
    if (check && check.required) {
        if (check.questions.length) return 'todo';
        if (check.status === 'prohibited') return 'failed';
        if (check.status === 'valid') return 'ok';
    }
    return r.aiAct.status === 'valid' ? 'ok' : r.aiAct.status === 'prohibited' ? 'failed' : 'todo';
}

/** The checklist rows of GET /:id/readiness, in the order the rail and the go-live dialog show them. */
export function readinessItems(r: Readiness, t: T, check?: AiActCheckResult): ReadinessItem[] {
    const out: ReadinessItem[] = [];
    out.push(r.stepsComplete.ok
        ? { key: 'steps', state: 'ok', label: t('automations.ready.steps_ok', 'All steps filled in') }
        : { key: 'steps', state: 'todo', label: r.stepsComplete.issues > 0
            ? t('automations.ready.steps_todo_n', '{n} steps still need something', { n: r.stepsComplete.issues })
            : t('automations.ready.steps_todo', 'Some steps still need something') });
    if (!r.lastTest) out.push({ key: 'test', state: 'todo', label: t('automations.ready.test_none', 'Not tested yet') });
    else {
        const ago = agoText(r.lastTest.at, t);
        const base = r.lastTest.ok ? t('automations.ready.test_ok', 'Last test passed') : t('automations.ready.test_failed', 'Last test failed');
        out.push({ key: 'test', state: r.lastTest.ok ? 'ok' : 'failed', label: ago ? `${base} · ${ago}` : base });
    }
    if (aiActVisible(r)) {
        const state = aiActState(r, check);
        out.push({
            key: 'aiAct',
            state,
            label: t('automations.ready.aiact', 'AI Act check'),
            section: state === 'ok' ? undefined : 'ai-act',
        });
    }
    out.push(r.description.ok
        ? { key: 'description', state: 'ok', label: t('automations.ready.description_ok', 'Description') }
        : { key: 'description', state: 'optional', label: t('automations.ready.description', 'Description (recommended)'), section: 'general' });
    return out;
}

/** The rows, each with its state icon; a row with a Settings section is a button when `onOpenSection` is given. */
export function ReadinessChecklist({ items: list, onOpenSection }: { items: ReadinessItem[]; onOpenSection?: (section: string) => void }) {
    return (
        <ul className="flex flex-col gap-2">
            {list.map(item => {
                const { Icon, tone } = ICON[item.state];
                const body = (
                    <>
                        <Icon className={`w-3.5 h-3.5 shrink-0 ${tone}`} aria-hidden />
                        <span className={item.state === 'optional' ? 'text-[var(--text-tertiary)]' : ''}>{item.label}</span>
                    </>
                );
                const section = item.section;
                return (
                    <li key={item.key} data-state={item.state} data-testid={`ready-${item.key}`}>
                        {section && onOpenSection ? (
                            <button type="button" onClick={() => onOpenSection(section)} className="flex items-center gap-2 text-left hover:underline">
                                {body}
                            </button>
                        ) : (
                            <span className="flex items-center gap-2">{body}</span>
                        )}
                    </li>
                );
            })}
        </ul>
    );
}

