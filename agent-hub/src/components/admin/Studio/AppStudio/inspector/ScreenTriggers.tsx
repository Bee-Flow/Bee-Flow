import { Plus, X } from 'lucide-react';
import FormField from '@/components/shared/FormField';
import IconButton from '@/components/shared/IconButton';
import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from './AiBrowsingSettings';
import { slotIds, withFirst, type SlotValue } from './eventSlots';
import { INPUT_CLS } from './panels/kit';
import { ActionSlotList, useActionChoices } from './ThenAlsoRun';
import { TRIGGER_LIMITS, nextTriggerId, screenTimers, setScreenOpen, setScreenTimers, type ScreenTimer } from '../state/triggerOps';
import type { AppDefinition } from './appDefinition';

/**
 * The screen's Triggers (schema 3), under its settings in the theme panel: what runs when
 * the screen opens, and timers that run an action every few seconds while it is open.
 * Neither fires in the editor (not on the canvas, not in the preview): they run in the
 * app itself, so the hint under each says where to see them work.
 */

export interface ScreenTriggersProps {
    definition: AppDefinition;
    screenId: string | null;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}

const ADD_BTN = 'self-start inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';

/** A whole number of seconds within the timer bounds. */
export function clampSeconds(raw: unknown): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return TRIGGER_LIMITS.MIN_TIMER_SECONDS;
    return Math.min(Math.max(n, TRIGGER_LIMITS.MIN_TIMER_SECONDS), TRIGGER_LIMITS.MAX_TIMER_SECONDS);
}

export default function ScreenTriggers({ definition, screenId, onCommit, disabled = false }: ScreenTriggersProps) {
    const { t } = useTranslation();
    const choices = useActionChoices(definition);
    const screen = (definition?.screens || []).find((s) => s.id === screenId) || null;
    if (!screen || !screenId) return null;
    const open = (screen.events as { onOpen?: unknown } | undefined)?.onOpen;
    const timers = screenTimers(screen);
    const commit = (next: AppDefinition) => { if (next !== definition) onCommit(next); };
    const commitOpen = (slot: SlotValue) => commit(setScreenOpen(definition, screenId, slot));
    const commitTimers = (list: ScreenTimer[]) => commit(setScreenTimers(definition, screenId, list));
    const patchTimer = (i: number, patch: Partial<ScreenTimer>) => commitTimers(timers.map((tm, j) => (j === i ? { ...tm, ...patch } : tm)));
    const first = choices[0]?.id;

    return (
        <div data-testid="screen-triggers">
            <SectionTitle>{t('studio_apps_triggers.screen.title', 'Triggers')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <FormField label={t('studio_apps_triggers.screen.on_open', 'When the screen opens')} hint={t('studio_apps_triggers.screen.on_open_hint', 'Runs each time someone opens this screen in the app. Not in the editor.')}>
                    <select
                        className={INPUT_CLS}
                        value={slotIds(open)[0] || ''}
                        onChange={(e) => commitOpen(withFirst(open, e.target.value || null))}
                        disabled={disabled}
                        aria-label={t('studio_apps_triggers.screen.on_open_aria', 'Action when the screen opens')}
                    >
                        <option value="">{t('studio_apps_triggers.screen.nothing', 'Nothing')}</option>
                        {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                </FormField>
                <ActionSlotList slot={open} choices={choices} onChange={commitOpen} disabled={disabled} />

                <FormField label={t('studio_apps_triggers.screen.timers', 'Timers')} hint={t('studio_apps_triggers.screen.timers_hint', 'Run an action every few seconds while the screen is open and the browser tab is visible.')}>
                    <div className="flex flex-col gap-2">
                        {timers.map((timer, i) => (
                            <div key={timer.id || i} className="flex items-center gap-2" data-app-timer={timer.id}>
                                <input
                                    type="number"
                                    className={`${INPUT_CLS} w-20`}
                                    min={TRIGGER_LIMITS.MIN_TIMER_SECONDS}
                                    max={TRIGGER_LIMITS.MAX_TIMER_SECONDS}
                                    value={timer.everySeconds}
                                    onChange={(e) => patchTimer(i, { everySeconds: clampSeconds(e.target.value) })}
                                    disabled={disabled}
                                    aria-label={t('studio_apps_triggers.screen.every_seconds', 'Every how many seconds')}
                                />
                                <span className="text-xs text-[var(--text-secondary)] shrink-0">{t('studio_apps_triggers.screen.seconds_run', 's, run')}</span>
                                <select
                                    className={INPUT_CLS}
                                    value={timer.actionId}
                                    onChange={(e) => patchTimer(i, { actionId: e.target.value })}
                                    disabled={disabled}
                                    aria-label={t('studio_apps_triggers.screen.timer_action', 'Action of this timer')}
                                >
                                    {choices.some((c) => c.id === timer.actionId) ? null : <option value={timer.actionId}>{timer.actionId}</option>}
                                    {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                                </select>
                                <IconButton ariaLabel={t('studio_apps_triggers.screen.remove_timer', 'Remove this timer')} onClick={() => commitTimers(timers.filter((_, j) => j !== i))} disabled={disabled}>
                                    <X />
                                </IconButton>
                            </div>
                        ))}
                        {timers.length < TRIGGER_LIMITS.MAX_SCREEN_TIMERS && first ? (
                            <button
                                type="button"
                                className={ADD_BTN}
                                disabled={disabled}
                                onClick={() => commitTimers([...timers, { id: nextTriggerId('timer', timers), everySeconds: 30, actionId: first }])}
                            >
                                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                                {t('studio_apps_triggers.screen.add_timer', 'Add a timer')}
                            </button>
                        ) : null}
                        {!first ? <span className="text-xs text-[var(--text-muted)]">{t('studio_apps_triggers.screen.no_actions', 'Add an action to the app first: a trigger runs one of its actions.')}</span> : null}
                    </div>
                </FormField>
            </div>
        </div>
    );
}
