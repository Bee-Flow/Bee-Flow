import { CalendarClock, ClipboardList, FilePlus, Info, Mail, MousePointerClick, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useTriggerProvidersQuery } from '../../../../api/queries/automation/settings';
import Modal from '../../../shared/Modal';
import { defaultFormDeclaration } from '../flow/settings/FormBuilderFields';
import ScheduleInWords from './ScheduleInWords';
import { PRIMARY_BTN, SECONDARY_BTN } from './settingsUi';
import { START_CARDS, cardFromTrigger, cronFromWords, triggerFromChoice, wordsFromCron } from './startChoice';
import type { ScheduleWords, StartCard, TriggerStep } from './startChoice';

export const START_CARD_ICON: Record<StartCard, LucideIcon> = {
    manual: MousePointerClick, schedule: CalendarClock, file: FilePlus, form: ClipboardList, email: Mail, app: Zap,
};

interface Props {
    open: boolean;
    trigger: TriggerStep | null;
    onClose: () => void;
    /** Resolves when the new start is saved; a rejection keeps the dialog open. */
    onApply: (next: TriggerStep) => Promise<unknown> | unknown;
}

/** Card title + one-line hint per start (artboard 5e-2). */
export function useStartCardText() {
    const { t } = useTranslation();
    return {
        manual: [t('automations.settings.start_manual', 'Manually'), t('automations.settings.start_manual_when', 'When someone starts it, for example with Test')],
        schedule: [t('automations.settings.start_schedule', 'At a set time'), t('automations.settings.start_schedule_hint', 'Every day, week or month')],
        file: [t('automations.settings.start_file', 'New file'), t('automations.settings.start_file_hint', 'When something lands in a folder')],
        form: [t('automations.settings.start_form', 'Form filled in'), t('automations.settings.start_form_hint', 'A form page people fill in')],
        email: [t('automations.settings.start_email', 'E-mail received'), t('automations.settings.start_email_hint', 'At an address or with a label')],
        app: [t('automations.settings.start_app', 'Something in an app'), t('automations.settings.start_app_hint', 'Task, calendar, Talk, Deck…')],
    } satisfies Record<StartCard, [string, string]>;
}

/**
 * "When should this start?" (artboard 5e-2, 680 wide): six start cards, the
 * schedule in words for "At a set time", and "Set start". Opened from the
 * start card in Settings; the start card on the canvas follows the saved
 * definition.
 */
export default function StartDialog({ open, trigger, onClose, onApply }: Props) {
    const { t } = useTranslation();
    const text = useStartCardText();
    const [card, setCard] = useState<StartCard | null>(() => cardFromTrigger(trigger));
    const [words, setWords] = useState<ScheduleWords>(() => wordsFromCron(trigger?.schedule?.cron));
    const [tz, setTz] = useState(trigger?.schedule?.tz || 'Europe/Amsterdam');
    const [skipHolidays, setSkipHolidays] = useState(!!trigger?.schedule?.skipHolidays);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const providers = useTriggerProvidersQuery({ enabled: open && card === 'email' });

    const apply = async () => {
        if (!card) return;
        setSaving(true);
        setError(null);
        try {
            const cron = words.freq === 'custom' ? words.cron : cronFromWords(words);
            await onApply(triggerFromChoice(trigger, {
                card, cron, tz, skipHolidays, providers: providers.data, defaultForm: defaultFormDeclaration,
            }));
            onClose();
        } catch (e) {
            setError((e as Error)?.message || t('automations.settings.save_failed', 'Could not save this change.'));
        }
        setSaving(false);
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            size="auto"
            className="w-full max-w-[680px]"
            label={t('automations.settings.start_dialog_title', 'When should this start?')}
            variant="bare"
        >
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-xl text-[12px] text-[var(--text-primary)] flex flex-col max-h-[90vh]">
                <div className="flex items-center justify-between px-5 py-3.5 border-b border-[var(--border-default)]">
                    <h2 className="text-[15px] font-semibold">{t('automations.settings.start_dialog_title', 'When should this start?')}</h2>
                    <button type="button" onClick={onClose} aria-label={t('common.close', 'Close')} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <X size={16} />
                    </button>
                </div>
                <div className="p-5 flex flex-col gap-4 overflow-y-auto">
                    <div className="@container/cards">
                        <div role="radiogroup" aria-label={t('automations.settings.start_dialog_title', 'When should this start?')} className="grid grid-cols-2 @[520px]/cards:grid-cols-3 gap-2.5">
                            {START_CARDS.map((key) => {
                                const Icon = START_CARD_ICON[key];
                                const selected = card === key;
                                return (
                                    <button
                                        key={key}
                                        type="button"
                                        role="radio"
                                        aria-checked={selected}
                                        onClick={() => setCard(key)}
                                        className={`text-left p-3 rounded-[10px] border flex flex-col gap-1 transition ${selected
                                            ? 'border-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_6%,var(--bg-card))]'
                                            : 'border-[var(--border-default)] hover:bg-[var(--bg-tertiary)]'}`}
                                    >
                                        <Icon size={16} className="text-[var(--type-trigger)]" />
                                        <span className="font-semibold">{text[key][0]}</span>
                                        <span className="text-[var(--text-tertiary)]">{text[key][1]}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    {card === 'schedule' && (
                        <ScheduleInWords
                            words={words}
                            tz={tz}
                            skipHolidays={skipHolidays}
                            onChange={(n) => {
                                if (n.words) setWords(n.words);
                                if (n.tz) setTz(n.tz);
                                if (n.skipHolidays !== undefined) setSkipHolidays(n.skipHolidays);
                            }}
                        />
                    )}
                    {card === 'app' && (
                        <p className="text-[var(--text-secondary)]">
                            {t('automations.settings.start_app_note', 'Choose the app and what should happen in it on the start card in the editor.')}
                        </p>
                    )}
                    {!card && (
                        <p className="text-[var(--text-secondary)]">
                            {t('automations.settings.start_other_note', 'This automation starts another way now (a webhook, an agent or an app action). Pick a card to replace it.')}
                        </p>
                    )}
                    {error && <div role="alert" className="text-[var(--error)]">{error}</div>}
                </div>
                <div className="flex items-center gap-2 px-5 py-3 border-t border-[var(--border-default)]">
                    <span className="mr-auto inline-flex items-center gap-1.5 text-[var(--text-tertiary)]">
                        <Info size={13} /> {t('automations.settings.start_canvas_note', 'The start card on the canvas changes too')}
                    </span>
                    <button type="button" className={SECONDARY_BTN} onClick={onClose}>{t('common.cancel', 'Cancel')}</button>
                    <button type="button" className={PRIMARY_BTN} onClick={apply} disabled={!card || saving}>
                        {t('automations.settings.set_start', 'Set start')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
