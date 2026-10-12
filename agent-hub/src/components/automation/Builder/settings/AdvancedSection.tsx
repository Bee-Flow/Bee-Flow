import { ChevronRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import WebhookPanel from '../WebhookPanel';
import { Choice, FieldGrid, ReadOnlyFieldset, SELECT, useDebouncedSave, withDefinition } from './settingsUi';
import type { SaveFn, SettingsAutomation } from './settingsUi';

/** `definition.runPolicy` (server: core/automationRunner/runPolicy.js). */
export interface RunPolicy {
    retry?: { max?: number; then?: 'stop_notify' | 'continue' };
    maxDurationMin?: number | null;
    concurrency?: 'serial' | 'parallel';
    retentionDays?: number | null;
}

const RETENTION_CHOICES = [7, 30, 90, 180, 365];

export function readRunPolicy(a: SettingsAutomation | null | undefined): RunPolicy {
    const raw = a?.definition?.runPolicy;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as RunPolicy : {};
}

/** Clamp a typed duration into the server's 1..60 range; empty = no limit. */
export function parseDuration(value: string): number | null {
    if (!value.trim()) return null;
    const n = Math.trunc(Number(value));
    if (!Number.isFinite(n)) return null;
    return Math.min(Math.max(n, 1), 60);
}

interface Props {
    automation: SettingsAutomation | null;
    onSave: SaveFn;
    /** Open on mount (a deep link to #advanced). */
    defaultOpen?: boolean;
    /** The viewer may only look (a view or run share). */
    readOnly?: boolean;
}

/**
 * Settings › Advanced (artboard 5e-7), collapsed by default: what happens when
 * a step fails, the time budget, parallel runs, how long runs are kept, and
 * the webhooks. Every choice has a safe default and saves by itself.
 */
export default function AdvancedSection({ automation, onSave, defaultOpen = false, readOnly = false }: Props) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(defaultOpen);
    // A deep link to #advanced while the page is already open unfolds it too.
    useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);
    const policy = readRunPolicy(automation);
    const [duration, setDuration] = useState(policy.maxDurationMin ? String(policy.maxDurationMin) : '');
    const [error, setError] = useState<string | null>(null);
    useEffect(() => { setDuration(policy.maxDurationMin ? String(policy.maxDurationMin) : ''); }, [policy.maxDurationMin]);

    const savePolicy = async (patch: Partial<RunPolicy>) => {
        setError(null);
        const next: RunPolicy = { ...readRunPolicy(automation), ...patch };
        try { await onSave(withDefinition(automation, 'runPolicy', next)); } catch (e) { setError((e as Error)?.message || t('automations.settings.save_failed', 'Could not save this change.')); }
    };
    const durationSave = useDebouncedSave<string>((v) => void savePolicy({ maxDurationMin: parseDuration(v) }));

    const retryMax = policy.retry?.max ?? 0;
    const retryThen = policy.retry?.then ?? 'stop_notify';

    return (
        <div className="flex flex-col gap-3">
            <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                aria-expanded={open}
                className="flex items-center gap-2 text-left text-[var(--text-secondary)] flex-wrap"
            >
                <ChevronRight size={14} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                <h2 className="text-[15px] font-semibold text-[var(--text-primary)]">{t('automations.settings.advanced', 'Advanced')}</h2>
                {!open && <span className="text-[12px]">{t('automations.settings.advanced_summary', 'error handling · maximum duration · keeping runs · webhooks')}</span>}
            </button>
            {open && (
                <ReadOnlyFieldset readOnly={readOnly} className="flex flex-col gap-3">
                    <FieldGrid>
                        <span className="pt-1 font-medium">{t('automations.settings.retry_label', 'If a step fails')}</span>
                        <div className="flex items-center gap-2 flex-wrap">
                            <select
                                aria-label={t('automations.settings.retry_times', 'Retries')}
                                className={SELECT}
                                value={retryMax}
                                onChange={(e) => void savePolicy({ retry: { max: Number(e.target.value), then: retryThen } })}
                            >
                                <option value={0}>{t('automations.settings.retry_none', 'Do not retry')}</option>
                                {[1, 2, 3, 4, 5].map((n) => (
                                    <option key={n} value={n}>{t('automations.settings.retry_n', 'Try {n}× more', { n })}</option>
                                ))}
                            </select>
                            <span>{t('automations.settings.retry_then', 'then')}</span>
                            <select
                                aria-label={t('automations.settings.retry_after', 'After the last attempt')}
                                className={SELECT}
                                value={retryThen}
                                onChange={(e) => void savePolicy({ retry: { max: retryMax, then: e.target.value as 'stop_notify' | 'continue' } })}
                            >
                                <option value="stop_notify">{t('automations.settings.retry_stop', 'stop and notify')}</option>
                                <option value="continue">{t('automations.settings.retry_continue', 'carry on with the next step')}</option>
                            </select>
                        </div>

                        <label htmlFor="automation-settings-duration" className="pt-1 font-medium">{t('automations.settings.max_duration', 'Maximum duration')}</label>
                        <div className="flex items-center gap-2 flex-wrap">
                            <input
                                id="automation-settings-duration"
                                type="number"
                                min={1}
                                max={60}
                                placeholder={t('automations.settings.no_limit', 'No limit')}
                                className={`${SELECT} w-24`}
                                value={duration}
                                onChange={(e) => { setDuration(e.target.value); durationSave.schedule(e.target.value); }}
                                onBlur={durationSave.flush}
                            />
                            <span>{t('automations.settings.minutes', 'minutes')}</span>
                            <span className="text-[var(--text-tertiary)]">{t('automations.settings.max_duration_hint', 'waiting for people does not count')}</span>
                        </div>

                        <span className="pt-1 font-medium">{t('automations.settings.concurrency', 'Run at the same time')}</span>
                        <div>
                            <Choice
                                label={t('automations.settings.concurrency', 'Run at the same time')}
                                value={policy.concurrency || 'serial'}
                                onChange={(v) => void savePolicy({ concurrency: v })}
                                options={[
                                    { value: 'serial', label: t('automations.settings.concurrency_serial', 'One at a time') },
                                    { value: 'parallel', label: t('automations.settings.concurrency_parallel', 'Allowed at the same time') },
                                ]}
                            />
                        </div>

                        <label htmlFor="automation-settings-retention" className="pt-1 font-medium">{t('automations.settings.retention', 'Keep runs')}</label>
                        <div className="flex items-center gap-2 flex-wrap">
                            <select
                                id="automation-settings-retention"
                                className={SELECT}
                                value={policy.retentionDays ?? ''}
                                onChange={(e) => void savePolicy({ retentionDays: e.target.value ? Number(e.target.value) : null })}
                            >
                                <option value="">{t('automations.settings.retention_default', 'As long as the organisation allows')}</option>
                                {RETENTION_CHOICES.map((d) => <option key={d} value={d}>{t('automations.settings.retention_days', '{n} days', { n: d })}</option>)}
                            </select>
                            <span className="text-[var(--text-tertiary)]">{t('automations.settings.retention_hint', 'organisation policy · the shorter period wins')}</span>
                        </div>
                    </FieldGrid>
                    {/* runPolicy lives in the definition, so it follows the live split. */}
                    {automation?.liveVersion != null && (
                        <p className="text-[var(--text-tertiary)]">
                            {t('automations.settings.advanced_live_note', 'Live runs use these settings once you make the new version live.')}
                        </p>
                    )}
                    {error && <div role="alert" className="text-[12px] text-[var(--error)]">{error}</div>}
                    {automation?.id && (
                        <div className="pt-3 border-t border-[var(--border-default)]">
                            <WebhookPanel automation={automation} />
                        </div>
                    )}
                </ReadOnlyFieldset>
            )}
        </div>
    );
}
