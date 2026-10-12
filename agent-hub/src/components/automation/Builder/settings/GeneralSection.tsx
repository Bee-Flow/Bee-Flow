import { Folder } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useAutomationFoldersQuery } from '../../../../api/queries/automation/settings';
import { IconPicker as IconPickerJsx, StepIcon } from '../flow/stepIcons';
import DescriptionSuggestion from './DescriptionSuggestion';
import GeneralActions from './GeneralActions';
import { FIELD, FieldGrid, FieldLabel, ReadOnlyFieldset, SELECT, SectionHeading, useDebouncedSave } from './settingsUi';
import type { SaveFn, SettingsAutomation } from './settingsUi';

// The picker is JS with a `null` placeholder default; typed loosely, as in BuilderHeader.
const IconPicker = IconPickerJsx as unknown as ComponentType<Record<string, unknown>>;

// The four symbols the artboard offers inline; the rest sit behind "More…".
const QUICK_ICONS = ['Zap', 'Folder', 'Receipt', 'Mail'];

interface Props {
    automation: SettingsAutomation | null;
    onSave: SaveFn;
    onAutomationChange?: (next: SettingsAutomation) => void;
    /** The viewer may only look (a view or run share). */
    readOnly?: boolean;
}

/**
 * Settings › General (artboards 5b + 5e-1): name, description with Bee's
 * proposal, folder, icon, and the whole-automation actions. Everything saves by
 * itself; text fields after a short pause or on blur.
 */
export default function GeneralSection({ automation, onSave, onAutomationChange, readOnly = false }: Props) {
    const { t } = useTranslation();
    const [title, setTitle] = useState(automation?.title || '');
    const [description, setDescription] = useState(automation?.description || '');
    const typing = useRef({ title: false, description: false });
    const [error, setError] = useState<string | null>(null);

    // Pick up an outside change (the header rename, the AI builder) unless the
    // user is typing in that very field: their keystrokes win.
    useEffect(() => { if (!typing.current.title) setTitle(automation?.title || ''); }, [automation?.title]);
    useEffect(() => { if (!typing.current.description) setDescription(automation?.description || ''); }, [automation?.description]);

    const save = async (patch: Record<string, unknown>) => {
        setError(null);
        try { await onSave(patch); } catch (e) { setError((e as Error)?.message || t('automations.settings.save_failed', 'Could not save this change.')); }
    };
    // A name is required (the server refuses a blank one): an emptied field
    // saves nothing and falls back to the stored name when it loses focus.
    const titleSave = useDebouncedSave<string>((v) => {
        typing.current.title = false;
        const name = v.trim();
        if (name && name !== (automation?.title || '')) void save({ title: name });
    });
    const descSave = useDebouncedSave<string>((v) => { typing.current.description = false; void save({ description: v || null }); });

    const folders = useAutomationFoldersQuery({ enabled: !!automation?.id });
    // Moving an automation to another folder is the owner's (routes: folderId on PUT).
    const isOwner = (automation?.myRole ?? 'owner') === 'owner';
    const icon = typeof automation?.icon === 'string' ? automation.icon : '';

    return (
        <div className="flex flex-col gap-3">
            <SectionHeading>{t('automations.settings.general', 'General')}</SectionHeading>
            <ReadOnlyFieldset readOnly={readOnly}>
            <FieldGrid>
                <FieldLabel htmlFor="automation-settings-name">{t('automations.settings.name', 'Name')}</FieldLabel>
                <input
                    id="automation-settings-name"
                    className={FIELD}
                    value={title}
                    onChange={(e) => { typing.current.title = true; setTitle(e.target.value); titleSave.schedule(e.target.value); }}
                    onBlur={() => {
                        titleSave.flush();
                        if (!title.trim()) setTitle(automation?.title || '');
                    }}
                />

                <FieldLabel htmlFor="automation-settings-description" hint={t('automations.settings.description_hint', 'Colleagues see this in the list and in the app')}>
                    {t('automations.settings.description_label', 'What does this automation do?')}
                </FieldLabel>
                <div className="flex flex-col gap-1.5">
                    <textarea
                        id="automation-settings-description"
                        rows={3}
                        className={`${FIELD} resize-y min-h-[52px]`}
                        value={description}
                        placeholder={t('automations.settings.description_placeholder', 'For example: "Collects the new invoices every morning and gets them ready for Finance."')}
                        onChange={(e) => { typing.current.description = true; setDescription(e.target.value); descSave.schedule(e.target.value); }}
                        onBlur={descSave.flush}
                    />
                    {automation?.id && !readOnly && (
                        <DescriptionSuggestion
                            automationId={automation.id}
                            onAccept={(text) => { setDescription(text); void save({ description: text }); }}
                            onEdit={(text) => {
                                setDescription(text);
                                void save({ description: text });
                                document.getElementById('automation-settings-description')?.focus();
                            }}
                        />
                    )}
                </div>

                <FieldLabel htmlFor="automation-settings-folder">{t('automations.settings.folder', 'Folder')}</FieldLabel>
                <div className="flex items-center gap-2">
                    <Folder size={14} className="text-[var(--text-tertiary)] shrink-0" />
                    <select
                        id="automation-settings-folder"
                        className={SELECT}
                        value={automation?.folderId || ''}
                        onChange={(e) => void save({ folderId: e.target.value || null })}
                        disabled={!automation?.id || !isOwner}
                    >
                        <option value="">{t('automations.settings.no_folder', 'No folder')}</option>
                        {(folders.data || []).map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                </div>

                <span className="pt-2 font-medium text-[var(--text-primary)]">{t('automations.settings.icon', 'Icon')}</span>
                <div className="flex items-center gap-1.5 flex-wrap" role="group" aria-label={t('automations.settings.icon', 'Icon')}>
                    {QUICK_ICONS.map((name) => (
                        <button
                            key={name}
                            type="button"
                            aria-pressed={icon === name}
                            aria-label={name}
                            onClick={() => void save({ icon: name })}
                            className={`w-8 h-8 rounded-lg grid place-items-center border transition ${icon === name
                                ? 'border-[var(--accent-primary)] bg-[color-mix(in_srgb,var(--accent-primary)_12%,transparent)] text-[var(--text-primary)]'
                                : 'border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'}`}
                        >
                            <StepIcon name={name} size={14} />
                        </button>
                    ))}
                    <IconPicker
                        value={QUICK_ICONS.includes(icon) ? '' : icon}
                        onChange={(name: string) => void save({ icon: name || null })}
                        size={14}
                        title={t('automations.settings.more_icons', 'More…')}
                        placeholder={<span className="px-2 text-[12px]">{t('automations.settings.more_icons', 'More…')}</span>}
                        buttonClassName="h-8 min-w-8 px-1 rounded-lg grid place-items-center border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                    />
                </div>
            </FieldGrid>
            </ReadOnlyFieldset>
            {error && <div role="alert" className="text-[12px] text-[var(--error)]">{error}</div>}
            {automation?.id && (
                <GeneralActions automation={automation} onAutomationChange={onAutomationChange} />
            )}
        </div>
    );
}
