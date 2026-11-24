/**
 * "What", the first row of a task's Settings (./CoworkTaskSettings.tsx), opened: its name and its sentence, and under
 * them the target to track (./TaskSetTarget.tsx).
 *
 * A new name is saved at once. A new sentence of a task with fixed steps is "Save and test": Cowork makes the steps
 * again from it and tests them once, nothing is sent, and the owner approves the changed steps before it runs again
 * (./coworkTaskSettingsModel.ts mustRebuild; the bar says so before the save, ./taskRows.tsx SaveBar).
 */
import TaskSetTarget from './TaskSetTarget';
import { SaveBar } from './taskRows';
import { FIELD, LABEL } from './taskUi';
import { useSettingRow, type SettingRowForm } from './useTaskSettingsSave';
import type { TranslateFn } from '@/hooks/useTranslation';

export default function TaskSetWhat({ form, t }: { form: SettingRowForm; t: TranslateFn }) {
    const { draft, set, submit, bar } = useSettingRow('what', form);
    const id = `cowork-task-what-${form.itemId}`;
    return (
        <>
            <form className="flex flex-col gap-4" onSubmit={(e) => { void submit(e); }}>
                <div className="flex flex-col gap-1">
                    <label htmlFor={`${id}-name`} className={LABEL}>{t('cowork_task.edit.name', 'Name')}</label>
                    <input id={`${id}-name`} type="text" className={FIELD} maxLength={500} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
                </div>
                <div className="flex flex-col gap-1">
                    <label htmlFor={`${id}-brief`} className={LABEL}>{t('cowork_task.edit.brief', 'What should be done?')}</label>
                    <textarea id={`${id}-brief`} rows={4} className={`${FIELD} py-2 resize-y`} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
                </div>
                <SaveBar state={bar} onCancel={form.onDone} t={t} />
            </form>
            <TaskSetTarget coworkId={form.itemId} t={t} />
        </>
    );
}
