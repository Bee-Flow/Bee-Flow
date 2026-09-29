import { Webhook } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { describeCron } from '../flow/scheduleBuilderUtils';
import { triggerTypeLabel } from '../flow/triggerLabels';
import StartDialog, { START_CARD_ICON } from './StartDialog';
import { LINK_BTN, SectionHeading, withDefinition } from './settingsUi';
import type { SaveFn, SettingsAutomation } from './settingsUi';
import { cardFromTrigger } from './startChoice';
import type { StartCard, TriggerStep } from './startChoice';

interface Props {
    automation: SettingsAutomation | null;
    onSave: SaveFn;
}

type T = ReturnType<typeof useTranslation>['t'];

/** "Start: manual" and the line under it, for the start card. */
function startWords(trigger: TriggerStep | null, card: StartCard | null, t: T): { name: string; detail: string } {
    const shortName: Record<StartCard, string> = {
        manual: t('routines.settings.start_short_manual', 'manual'),
        schedule: t('routines.settings.start_short_schedule', 'on a schedule'),
        file: t('routines.settings.start_short_file', 'new file'),
        form: t('routines.settings.start_short_form', 'form'),
        email: t('routines.settings.start_short_email', 'e-mail'),
        app: t('routines.settings.start_short_app', 'something in an app'),
    };
    const name = card ? shortName[card] : triggerTypeLabel(trigger);
    if (card === 'schedule') return { name, detail: describeCron(trigger?.schedule?.cron || '', { t, tz: trigger?.schedule?.tz || 'Europe/Amsterdam' }) };
    if (card === 'manual') return { name, detail: t('routines.settings.start_manual_only', 'Only when someone starts it') };
    if (card === 'form') return { name, detail: t('routines.settings.start_form_detail', 'Every answer to the form starts a run') };
    return { name, detail: card ? triggerTypeLabel(trigger) : '' };
}

/**
 * Settings › Start (artboard 5b): the start card ("Start: manually ·
 * change"). It writes the definition through `onSave`; the canvas start card
 * follows it.
 */
export default function StartSection({ automation, onSave }: Props) {
    const { t } = useTranslation();
    const [startOpen, setStartOpen] = useState(false);
    const trigger = (automation?.definition?.trigger || null) as TriggerStep | null;
    const card = cardFromTrigger(trigger);
    const Icon = card ? START_CARD_ICON[card] : Webhook;
    const { name: startName, detail: startDetail } = startWords(trigger, card, t);

    return (
        <div className="flex flex-col gap-3">
            <SectionHeading>{t('routines.settings.start_section', 'Start')}</SectionHeading>
            <div className="@container/start">
                <div className="grid grid-cols-1 @[560px]/start:grid-cols-2 gap-2.5 text-[12px]">
                    <div className="flex gap-2.5 p-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]">
                        <Icon size={16} className="text-[var(--type-trigger)] shrink-0" />
                        <div className="min-w-0">
                            <div className="font-semibold">{t('routines.settings.start_label', 'Start: {name}', { name: startName })}</div>
                            <div className="mt-0.5 text-[var(--text-tertiary)]">
                                {startDetail}{startDetail ? ' · ' : ''}
                                <button type="button" className={`${LINK_BTN} text-[var(--text-secondary)]`} onClick={() => setStartOpen(true)} disabled={!automation}>
                                    {t('routines.settings.change', 'change')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            {startOpen && (
                <StartDialog
                    open
                    trigger={trigger}
                    onClose={() => setStartOpen(false)}
                    onApply={(next) => onSave(withDefinition(automation, 'trigger', next))}
                />
            )}
        </div>
    );
}
