import { Check, Lock } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import WorkModePicker, { WORK_MODES } from './WorkModePicker';

export default function AssistantCapabilities({ workMode, onChange }) {
    const { t } = useTranslation();
    const rows = [
        [t('routines.assistant.rights.read_flow', 'Read the flow, steps and settings'), [true, true, true, true]],
        [t('routines.assistant.rights.read_mapping', 'Read mappings and available fields'), [true, true, true, true]],
        [t('routines.assistant.rights.read_run', 'Read run values · personal data masked'), [true, true, true, true]],
        [t('routines.assistant.rights.change', 'Add steps, edit settings and map fields'), [false, 'proposal', 'plan', true]],
        [t('routines.assistant.rights.remove', 'Remove a step'), [false, 'proposal', false, false]],
        [t('routines.assistant.rights.test', 'Execute a test run'), [false, false, false, true]],
        [t('routines.assistant.rights.live', 'Activate or publish'), [false, false, false, false]],
    ];
    return <div className="space-y-4">
        <div><h2 className="font-semibold text-sm">{t('routines.assistant.title', 'Assistant')}</h2><p className="text-xs text-[var(--text-secondary)] mt-1">{t('routines.assistant.rights.hint', 'Choose what the assistant may do. This work mode is remembered for this automation.')}</p></div>
        <WorkModePicker value={workMode} onChange={onChange} />
        <div className="overflow-x-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]">
            <table className="w-full text-xs"><thead><tr className="border-b border-[var(--border-default)]"><th className="p-3 text-left font-medium">{t('routines.assistant.rights.action', 'Action')}</th>{WORK_MODES.map(m => <th key={m.id} className="p-2 font-medium text-[var(--text-secondary)]" title={t(`routines.assistant.mode.${m.key}`, m.label)}><m.Icon size={15} className="mx-auto" /><span className="sr-only">{t(`routines.assistant.mode.${m.key}`, m.label)}</span></th>)}</tr></thead>
                <tbody>{rows.map(([label, permissions]) => <tr key={label} className="border-b last:border-0 border-[var(--border-default)]"><th className="p-3 font-normal text-left">{label}</th>{permissions.map((permission, i) => <td key={i} className="p-2 text-center text-[var(--text-secondary)]">{permission === true ? <Check size={13} className="mx-auto" aria-label={t('routines.assistant.rights.allowed', 'Allowed')} /> : permission === false ? '—' : t(`routines.assistant.rights.${permission}`, permission === 'plan' ? 'plan' : 'approve')}</td>)}</tr>)}</tbody>
            </table>
        </div>
        <p className="flex items-start gap-2 text-xs text-[var(--text-secondary)]"><Lock size={13} className="shrink-0 mt-0.5" />{t('routines.assistant.rights.live_hint', 'A human always activates the automation. Approval of a plan only applies to that exact revision.')}</p>
    </div>;
}
