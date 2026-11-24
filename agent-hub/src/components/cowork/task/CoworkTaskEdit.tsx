/**
 * Editing a task, inside its sheet (./CoworkTaskView.tsx): its name and its sentence, when it starts (every start the
 * server supports, ./CoworkTaskEditWhen.tsx), and how it works: the AI each time, one of the owner's agents, or fixed
 * steps (for an organisation with automations).
 *
 * "Save and test" when the steps must be made again (./coworkTaskEditModel.ts mustRebuild): Cowork then makes them
 * from the sentence and tries them once, nothing sent, and the owner checks them before it runs again. Otherwise
 * "Save": a new name or schedule is saved right away and the steps stay as they are. A new webhook shows its address
 * once, here, before going back.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft } from 'lucide-react';
import CoworkTaskEditWhen, { HookAddressCard } from './CoworkTaskEditWhen';
import { canSave, mustRebuild, type EditDraft } from './coworkTaskEditModel';
import { useTaskEditSave } from './useTaskEditSave';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, FIELD, Failure, LABEL, META, ROW_ACTIONS, SECTION_H } from './taskUi';
import type { CoworkAgent } from '@/api/cowork.types';
import type { HookAddress } from '@/api/coworkStart';
import type { TaskMode } from './coworkTaskModel';
import type { TranslateFn } from '@/hooks/useTranslation';

const MODES: Array<[TaskMode, string, string, string, string]> = [
    ['ai', 'cowork_task.mode.ai', 'The AI does it each time', 'cowork_task.mode.ai_line', 'It reads your sentence and works out the steps on every run. Most flexible, a bit slower.'],
    ['agent', 'cowork_task.mode.agent', 'An agent of yours does it', 'cowork_task.mode.agent_line', 'One of your own agents runs it, with its own instructions and apps.'],
    ['steps', 'cowork_task.mode.steps', 'Fixed steps', 'cowork_task.mode.steps_line', 'The same steps every run, with AI only where something must be written or judged. Fastest and cheapest.'],
];

function HowItWorks({ draft, set, agents, mayPlan, id, t }: { draft: EditDraft; set: (p: Partial<EditDraft>) => void; agents: CoworkAgent[]; mayPlan: boolean; id: string; t: TranslateFn }) {
    const modes = MODES.filter(([mode]) => (mode !== 'steps' || mayPlan || draft.mode === 'steps') && (mode !== 'agent' || agents.length > 0 || draft.mode === 'agent'));
    return (
        <fieldset className="flex flex-col gap-2 border-0 p-0 m-0 min-w-0">
            <legend className={`${SECTION_H} mb-2.5`}>{t('cowork_task.edit.how', 'How it works')}</legend>
            {modes.map(([mode, key, en, lineKey, lineEn]) => (
                <label key={mode} htmlFor={`${id}-mode-${mode}`} aria-label={t(key, en)} className={`grid grid-cols-[auto_1fr] gap-x-3 items-start rounded-[var(--radius-md)] border px-3.5 py-3 cursor-pointer ${draft.mode === mode ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_6%,transparent)]' : 'border-[var(--border-subtle)]'}`}>
                    <input id={`${id}-mode-${mode}`} type="radio" name={`${id}-mode`} className="mt-1 w-4 h-4" checked={draft.mode === mode} onChange={() => set({ mode })} />
                    <span className="flex flex-col gap-0.5"><strong className="text-[15px]">{t(key, en)}</strong><span className={META}>{t(lineKey, lineEn)}</span></span>
                </label>
            ))}
            {draft.mode === 'agent' && (
                <div className="flex flex-col gap-1">
                    <label htmlFor={`${id}-agent`} className={LABEL}>{t('cowork_task.edit.which_agent', 'Which agent')}</label>
                    <select id={`${id}-agent`} className={FIELD} value={draft.agentId} onChange={(e) => set({ agentId: e.target.value })}>
                        <option value="">{t('cowork_task.when.choose', 'Choose…')}</option>
                        {agents.map((a) => <option key={a.id} value={a.id}>{a.name || t('cowork_task.edit.untitled_agent', 'Untitled agent')}</option>)}
                    </select>
                </div>
            )}
        </fieldset>
    );
}

interface CoworkTaskEditProps {
    itemId: string;
    initial: EditDraft;
    agents: CoworkAgent[];
    mayPlan: boolean;
    /** Make the steps again from the sentence and try them once. */
    onRebuild: () => void;
    onBack: () => void;
    t: TranslateFn;
}

export default function CoworkTaskEdit({ itemId, initial, agents, mayPlan, onRebuild, onBack, t }: CoworkTaskEditProps) {
    const [draft, setDraft] = useState<EditDraft>(initial);
    const [address, setAddress] = useState<HookAddress | null>(null);
    const set = (patch: Partial<EditDraft>) => setDraft((d) => ({ ...d, ...patch }));
    const { save, saving, error } = useTaskEditSave(itemId, initial, onRebuild);
    const rebuild = mustRebuild(draft, initial);
    const id = `cowork-task-edit-${itemId}`;
    const submit = async (e: FormEvent) => {
        e.preventDefault();
        const done = await save(draft);
        if (!done.ok) return;
        if (done.address) setAddress(done.address);
        else onBack();
    };
    if (address) {
        return (
            <div className="flex flex-col gap-5" data-testid="cowork-task-edit">
                <h2 className="text-[24px] font-bold text-[var(--text-primary)]">{t('cowork_task.edit.saved', 'Saved')}</h2>
                <HookAddressCard address={address} t={t} />
                <div><button type="button" className={BTN_PRIMARY} onClick={onBack}>{t('cowork_task.edit.back', 'Back to the task')}</button></div>
            </div>
        );
    }
    return (
        <form className="flex flex-col gap-5 text-[var(--text-primary)]" data-testid="cowork-task-edit" onSubmit={(e) => { void submit(e); }}>
            <div><button type="button" className={BTN_LINK} onClick={onBack}><ArrowLeft aria-hidden="true" className="w-4 h-4" />{t('cowork_task.edit.back', 'Back to the task')}</button></div>
            <h2 className="text-[24px] font-bold">{t('cowork_task.edit.heading', 'Edit task')}</h2>
            <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-name`} className={LABEL}>{t('cowork_task.edit.name', 'Name')}</label>
                <input id={`${id}-name`} type="text" className={FIELD} maxLength={500} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
            </div>
            <div className="flex flex-col gap-1">
                <label htmlFor={`${id}-brief`} className={LABEL}>{t('cowork_task.edit.brief', 'What should be done?')}</label>
                <textarea id={`${id}-brief`} rows={4} className={`${FIELD} py-2 resize-y`} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
            </div>
            <CoworkTaskEditWhen draft={draft} set={set} itemId={itemId} t={t} />
            <HowItWorks draft={draft} set={set} agents={agents} mayPlan={mayPlan} id={id} t={t} />
            <p className={META} data-testid="cowork-task-edit-note">
                {rebuild
                    ? t('cowork_task.edit.rebuild_note', 'After saving, Cowork makes the steps again and tests them once. Nothing is sent. You check the changed steps before it runs again.')
                    : t('cowork_task.edit.save_note', 'A new name or schedule is saved right away. The steps stay as they are.')}
            </p>
            <Failure error={error} t={t} />
            <div className={ROW_ACTIONS}>
                <button type="submit" className={BTN_PRIMARY} disabled={saving || !canSave(draft)}>
                    {rebuild ? t('cowork_task.edit.save_test', 'Save and test') : t('cowork_task.edit.save', 'Save')}
                </button>
                <button type="button" className={BTN_QUIET} onClick={onBack}>{t('cowork_task.edit.cancel', 'Cancel')}</button>
            </div>
        </form>
    );
}
