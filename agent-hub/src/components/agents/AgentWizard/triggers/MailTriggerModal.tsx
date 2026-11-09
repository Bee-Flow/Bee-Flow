/**
 * "New email trigger" for one agent: the same panel the Cowork composer uses, plus
 * the task the agent gets for each mail. Saves a Cowork item with `triggerKind: 'app_event'`,
 * so it shows up in the agent's schedules list (and in Cowork) next to the clock-based ones.
 */
import { X } from 'lucide-react';
import { useState } from 'react';
import { createCowork } from '@/api/coworkApi';
import type { CoworkRequestError } from '@/api/coworkApi';
import Modal from '@/components/shared/Modal';
import MailTriggerPanel from '@/components/cowork/MailTriggerPanel';
import { defaultMailTrigger, isMailTriggerReady, normaliseMailTrigger } from '@/components/cowork/mailTrigger';
import { titleFromBrief } from '@/components/cowork/coworkSchedule';
import { messageOf } from '@/utils/caughtError';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { MailTrigger } from '@/api/cowork.types';

interface MailTriggerModalProps {
    t: TranslateFn;
    agent: { id?: string | null; name?: string | null };
    onClose: () => void;
    onSaved: () => Promise<unknown> | void;
}

export default function MailTriggerModal({ t, agent, onClose, onSaved }: MailTriggerModalProps) {
    const [trigger, setTrigger] = useState<MailTrigger>(() => defaultMailTrigger());
    const [prompt, setPrompt] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        if (!agent.id) return;
        const text = prompt.trim();
        if (!text) { setError(t('agent_schedules.error_prompt_required', 'Prompt is required')); return; }
        setBusy(true);
        setError(null);
        try {
            await createCowork({
                title: titleFromBrief(text),
                prompt: text,
                repeatInterval: null,
                modelTier: 'auto',
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                agentId: String(agent.id),
                triggerKind: 'app_event',
                trigger: normaliseMailTrigger(trigger),
            });
            await onSaved();
            onClose();
        } catch (err) {
            setError((err as CoworkRequestError)?.code === 'mail_not_connected'
                ? t('cowork.mail_trigger.error_not_connected', 'That mail account is not connected. Connect it in Settings → Connections and try again.')
                : messageOf(err, t('cowork.error.create_failed', 'Could not create this work')));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            size="md"
            title={t('agent_schedules.mail_trigger_title', 'New email trigger')}
            headerActions={
                <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label={t('common.close', 'Close')}><X size={18} /></button>
            }
        >
            <div className="space-y-4">
                <p className="text-[12px] text-[var(--text-tertiary)]">
                    {t('agent_schedules.mail_trigger_intro', 'The agent starts by itself for every new email that matches. What it may do with the mailbox is set under Can use.')}
                </p>
                <div className="rounded-lg border border-[var(--border-subtle)]">
                    <MailTriggerPanel value={trigger} onChange={setTrigger} disabled={busy} />
                </div>
                <div>
                    <label htmlFor="mail-trigger-task" className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5 block">
                        {t('agent_schedules.mail_trigger_task', 'What should the agent do with each email?')}
                    </label>
                    <textarea
                        id="mail-trigger-task"
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        rows={4}
                        placeholder={t('agent_schedules.mail_trigger_task_placeholder', 'e.g. Summarise it and prepare a reply draft')}
                        className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-y"
                    />
                </div>
                {error && <div role="alert" className="text-xs text-red-500">{error}</div>}
                <div className="pt-2 flex justify-end gap-2">
                    <button type="button" onClick={onClose} className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition">
                        {t('agent_schedules.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={busy || !isMailTriggerReady(trigger)}
                        className="px-5 py-2 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
                    >
                        {busy ? '…' : t('agent_schedules.mail_trigger_save', 'Start watching')}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
