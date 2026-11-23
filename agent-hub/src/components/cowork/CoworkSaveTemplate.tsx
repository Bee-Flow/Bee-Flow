/**
 * "Save as template", for an item's Settings: the owner saves the item for their organisation, so colleagues can
 * start from it (./CoworkTemplates.tsx). What goes in is the title, the brief, how often it repeats and the approved
 * plan without its connections, credentials, approvers or test data; never its runs or who it is shared with.
 */
import { useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { useSaveCoworkTemplate } from '../../api/coworkTemplates';
import { useTranslation } from '../../hooks/useTranslation';
import { errorMessage } from '../../utils/caughtError';

const FIELD = 'rounded-lg border px-2 py-1 text-[12px] bg-[var(--bg-primary)] [border-color:var(--border-default)]';

export default function CoworkSaveTemplate({ coworkId, title }: { coworkId: string; title?: string | null }) {
    const { t } = useTranslation();
    const [name, setName] = useState(title ?? '');
    const save = useSaveCoworkTemplate(coworkId);
    const trimmed = name.trim();
    return (
        <details className="rounded-[10px] border px-[18px] py-3 [border-color:var(--border-subtle)]" data-testid="cowork-save-template">
            <summary className="cursor-pointer inline-flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-secondary)]">
                <LayoutTemplate aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_templates.save_heading', 'Save as template')}
            </summary>
            <div className="pt-2 flex flex-col gap-2">
                <p className="text-[12px] text-[var(--text-secondary)]">
                    {t('cowork_templates.save_hint', 'Colleagues in your organisation can start from it. It keeps the brief, the schedule and the approved plan, without your connections, approvers or runs.')}
                </p>
                <label className="flex flex-col gap-1 text-[12px] text-[var(--text-secondary)]">
                    {t('cowork_templates.save_name', 'Name of the template')}
                    <input className={FIELD} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
                </label>
                <div>
                    <button type="button" className="px-3 py-1.5 rounded-lg border text-[12px] font-medium [border-color:var(--border-default)] disabled:opacity-50" disabled={save.isPending} onClick={() => save.mutate(trimmed || undefined)}>
                        {t('cowork_templates.save', 'Save as template')}
                    </button>
                </div>
                {save.isSuccess && (
                    <div className="flex flex-col gap-0.5" role="status">
                        <span className="text-[12px] text-[var(--text-primary)]">{t('cowork_templates.saved', 'Saved. Colleagues find it under "Start from a template".')}</span>
                        {save.data.warnings.map((w) => <span key={w} className="text-[12px] text-[var(--text-tertiary)]">{w}</span>)}
                    </div>
                )}
                {save.error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{errorMessage(save.error) || t('cowork_plan.failed', 'That did not work. Try again.')}</p>}
            </div>
        </details>
    );
}
