import React from 'react';
import { Circle, CircleCheck, CircleDashed, CircleX, UserCog } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { readinessStamp, useReadiness, type Readiness } from '../../../../api/queries/automation/readiness';
import { useAiActCheck, type AiActCheckResult } from '../../../../api/queries/automation/aiActCheck';
import AiActAutoCard from './AiActAutoCard';
import { aiActVisible, canRecordAiAct } from './AiActSection';
import type { SettingsAutomation } from './settingsUi';

type T = ReturnType<typeof useTranslation>['t'];
type State = 'ok' | 'todo' | 'failed' | 'optional';

const ICON: Record<State, { Icon: typeof Circle; tone: string }> = {
    ok: { Icon: CircleCheck, tone: 'text-[var(--success)]' },
    todo: { Icon: CircleDashed, tone: 'text-[var(--warning)]' },
    failed: { Icon: CircleX, tone: 'text-[var(--error)]' },
    optional: { Icon: Circle, tone: 'text-[var(--text-tertiary)]' },
};

const PREFERENCES_PATH = '/app/settings/preferences';

/** In-app navigation, like the rest of the SPA: push the path, let the shell hear popstate. */
function openPreferences(e: React.MouseEvent<HTMLAnchorElement>) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    window.history.pushState({}, '', PREFERENCES_PATH);
    window.dispatchEvent(new PopStateEvent('popstate'));
}

/** "11 min ago", in words the catalogue can translate. */
export function agoText(iso: string | null, t: T, now = Date.now()): string {
    if (!iso) return '';
    const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
    if (minutes < 1) return t('routines.ready.ago_now', 'just now');
    if (minutes < 60) return t('routines.ready.ago_min', '{n} min ago', { n: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('routines.ready.ago_hours', '{n} h ago', { n: hours });
    return t('routines.ready.ago_days', '{n} days ago', { n: Math.floor(hours / 24) });
}

interface Item { key: string; state: State; label: string; section?: string }

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

function items(r: Readiness, t: T, check?: AiActCheckResult): Item[] {
    const out: Item[] = [];
    out.push(r.stepsComplete.ok
        ? { key: 'steps', state: 'ok', label: t('routines.ready.steps_ok', 'All steps filled in') }
        : { key: 'steps', state: 'todo', label: r.stepsComplete.issues > 0
            ? t('routines.ready.steps_todo_n', '{n} steps still need something', { n: r.stepsComplete.issues })
            : t('routines.ready.steps_todo', 'Some steps still need something') });
    if (!r.lastTest) out.push({ key: 'test', state: 'todo', label: t('routines.ready.test_none', 'Not tested yet') });
    else {
        const ago = agoText(r.lastTest.at, t);
        const base = r.lastTest.ok ? t('routines.ready.test_ok', 'Last test passed') : t('routines.ready.test_failed', 'Last test failed');
        out.push({ key: 'test', state: r.lastTest.ok ? 'ok' : 'failed', label: ago ? `${base} · ${ago}` : base });
    }
    if (aiActVisible(r)) {
        const state = aiActState(r, check);
        out.push({
            key: 'aiAct',
            state,
            label: t('routines.ready.aiact', 'AI Act check'),
            section: state === 'ok' ? undefined : 'ai-act',
        });
    }
    out.push(r.description.ok
        ? { key: 'description', state: 'ok', label: t('routines.ready.description_ok', 'Description') }
        : { key: 'description', state: 'optional', label: t('routines.ready.description', 'Description (recommended)'), section: 'general' });
    return out;
}

function RailStatus({ saved, loading, failed }: { saved: boolean; loading: boolean; failed: boolean }) {
    const { t } = useTranslation();
    let text: string | null = null;
    if (!saved) text = t('routines.ready.unsaved', 'Save the automation first.');
    else if (loading) text = t('routines.ready.loading', 'Checking…');
    else if (failed) text = t('routines.ready.error', 'Could not check right now.');
    return text ? <p className="text-[var(--text-tertiary)]">{text}</p> : null;
}

function Checklist({ items: list, onOpenSection }: { items: Item[]; onOpenSection?: (section: string) => void }) {
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

/**
 * The right column of Settings (artboard 5b): the AI Act card while Bee is
 * checking or has a question, the "Ready to activate?" checklist from GET
 * /:id/readiness, and the note that "Map fields automatically" moved to the
 * profile.
 */
export default function ReadinessRail({ automation, onOpenSection, extrasClassName = 'contents' }: {
    automation: SettingsAutomation | null;
    onOpenSection?: (section: string) => void;
    /**
     * Classes for the parts beyond the checklist (the AI Act card and the
     * profile note). The Settings page hides them while the rail shares a
     * column with the table of contents.
     */
    extrasClassName?: string;
}) {
    const { t } = useTranslation();
    const id = automation?.id || null;
    // The routine's version, updatedAt and description are part of the key: a
    // save refetches the checklist (readinessStamp).
    const stamp = readinessStamp(automation);
    const readiness = useReadiness(id, stamp);
    const r = readiness.data;
    const showAiAct = !!id && aiActVisible(r);
    const check = useAiActCheck(showAiAct ? id : null, stamp);

    return (
        <div className="flex flex-col gap-3 text-xs text-[var(--text-primary)]" data-testid="readiness-rail">
            {showAiAct && (
                <div className={extrasClassName}>
                    <AiActAutoCard variant="rail" automationId={id as string} stamp={stamp} canEdit={canRecordAiAct(automation)} />
                </div>
            )}

            <div className="p-3.5 rounded-xl bg-[var(--bg-secondary)] flex flex-col gap-2">
                <h3 className="font-semibold">{t('routines.ready.title', 'Ready to activate?')}</h3>
                <RailStatus saved={!!id} loading={readiness.isLoading} failed={readiness.isError} />
                {r && <Checklist items={items(r, t, check.data)} onOpenSection={onOpenSection} />}
            </div>

            <div className={extrasClassName}>
                <p className="flex gap-1.5 text-[var(--text-tertiary)] leading-4">
                    <UserCog className="w-[13px] h-[13px] shrink-0 mt-px" aria-hidden />
                    <span>
                        {t('routines.ready.automap_note', '"Map fields automatically" is a personal preference and now lives in your profile under')}{' '}
                        <a href={PREFERENCES_PATH} onClick={openPreferences} className="underline">{t('routines.ready.automap_link', 'Editor preferences')}</a>.
                    </span>
                </p>
            </div>
        </div>
    );
}
