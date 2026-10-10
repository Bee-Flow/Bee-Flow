// Settings: what the project is called and how the AI behaves in it.
//
// Saving echoes the version the form was loaded from. When someone else saved
// first the server answers 409; the form then shows THEIR version (never a
// silent overwrite) and offers to put the caller's edits back on top of it,
// so a second Save is a deliberate choice.

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Check, Save, Settings } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import {
    ProjectConflictError, projectKeys, useUpdateProject, type Project, type ProjectRole,
} from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import Toggle from '../../shared/Toggle';
import {
    ColorSwatches, DescriptionField, IconPicker, InstructionsField, NameField,
} from './ProjectIdentityFields';
import { projectErrorText } from './projectErrorText';
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON } from './projectVisuals';
import { ArchiveCard, EditorsInviteToggle, MuteCard, OwnershipCard } from './SettingsCollab';
import SettingsDanger from './SettingsDanger';
import { StudioSectionHeader } from './studioParts';
import { canEditProject, type WorkspaceTabProps } from './types';
import { Card, ErrorText, Notice, PrimaryButton, SecondaryButton } from './workspaceUi';

interface SettingsDraft {
    name: string;
    description: string;
    icon: string;
    color: string;
    customInstructions: string;
    extractMemories: boolean;
    editorsCanInvite: boolean;
}

const draftOf = (p: Project): SettingsDraft => ({
    name: p.name || '',
    description: p.description || '',
    icon: p.icon || DEFAULT_PROJECT_ICON,
    color: p.color || DEFAULT_PROJECT_COLOR,
    customInstructions: p.customInstructions || '',
    extractMemories: !!p.extractMemories,
    // The server's default is true; an older server sends nothing and then the field is never written back.
    editorsCanInvite: p.editorsCanInvite !== false,
});

const sameDraft = (a: SettingsDraft, b: SettingsDraft) => (Object.keys(a) as Array<keyof SettingsDraft>).every((k) => a[k] === b[k]);

interface Base {
    /** What the server holds, as form values: "dirty" means the draft differs from it. */
    draft: SettingsDraft;
    /** The version the draft is based on — the one a save echoes. */
    version: number | null;
    /** The project object last looked at, so each new object is examined once. */
    ref: Project;
}

const versionOf = (p: Project): number | null => (typeof p.version === 'number' ? p.version : null);
const baseOf = (p: Project): Base => ({ draft: draftOf(p), version: versionOf(p), ref: p });

/**
 * The form state. A newer version of the project (a colleague's save, arriving
 * through the live feed) replaces an untouched form. A form with edits keeps
 * them AND keeps the version they were based on, so saving it still meets the
 * server's conflict check instead of silently overwriting the colleague.
 */
function useSettingsForm(projectId: string, project: Project, role: ProjectRole) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    const update = useUpdateProject(projectId);
    const [draft, setDraft] = useState<SettingsDraft>(() => draftOf(project));
    const [base, setBase] = useState<Base>(() => baseOf(project));
    const [conflictDraft, setConflictDraft] = useState<SettingsDraft | null>(null);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const dirty = !sameDraft(draft, base.draft);

    if (project !== base.ref) {
        const v = versionOf(project);
        const newer = v === null || base.version === null || v > base.version;
        if (newer && !dirty) {
            setBase(baseOf(project));
            setDraft(draftOf(project));
        } else {
            setBase({ ...base, ref: project });
        }
    }

    function edit<K extends keyof SettingsDraft>(key: K) {
        return (value: SettingsDraft[K]) => {
            setSaved(false);
            setDraft((d) => ({ ...d, [key]: value }));
        };
    }

    const adopt = (p: Project) => { setBase(baseOf(p)); setDraft(draftOf(p)); };

    const reloadAfterConflict = async (e: ProjectConflictError, mine: SettingsDraft) => {
        let fresh: Project | undefined;
        if (e.current) {
            fresh = { ...project, ...e.current };
            qc.setQueryData(projectKeys.detail(projectId), fresh);
        } else {
            await qc.refetchQueries({ queryKey: projectKeys.detail(projectId) });
            fresh = qc.getQueryData<Project>(projectKeys.detail(projectId));
        }
        if (fresh) adopt(fresh);
        setConflictDraft(mine);
    };

    const save = async (invalidName: string) => {
        if (!draft.name.trim()) { setError(invalidName); return; }
        setError(null);
        setConflictDraft(null);
        const mine = draft;
        try {
            const { editorsCanInvite, ...rest } = draft;
            const result = await update.mutateAsync({
                ...rest,
                ...(role === 'owner' && project.editorsCanInvite !== undefined ? { editorsCanInvite } : {}),
                name: draft.name.trim(),
                description: draft.description.trim(),
                ...(base.version === null ? {} : { version: base.version }),
            });
            adopt({ ...project, ...result });
            setSaved(true);
        } catch (e) {
            if (e instanceof ProjectConflictError) await reloadAfterConflict(e, mine);
            else setError(projectErrorText(t, e, t('project_home.settings.save_failed', 'Could not save the settings.')));
        }
    };

    const restoreMine = () => {
        if (conflictDraft) setDraft(conflictDraft);
        setConflictDraft(null);
    };

    return { draft, edit, save, dirty, saved, error, conflict: !!conflictDraft, restoreMine, saving: update.isPending };
}

function MemoryToggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
                <p className="text-sm font-medium text-[var(--text-primary)] m-0">{t('project_home.settings.memory', 'Remember useful facts from chats')}</p>
                <p className="text-xs text-[var(--text-tertiary)] m-0 mt-0.5">
                    {t('project_home.settings.memory_help', 'The AI saves facts from chats in this project as project memory, so later chats can use them. Review them under Knowledge.')}
                </p>
            </div>
            <Toggle checked={checked} onChange={onChange} disabled={disabled} ariaLabel={t('project_home.settings.memory', 'Remember useful facts from chats')} />
        </div>
    );
}

function ConflictNotice({ onRestore }: { onRestore: () => void }) {
    const { t } = useTranslation();
    return (
        <Notice
            tone="warning"
            icon={AlertTriangle}
            role="alert"
            testId="settings-conflict"
            action={<SecondaryButton onClick={onRestore}>{t('project_home.settings.restore_mine', 'Put my edits back')}</SecondaryButton>}
        >
            {t('project_home.settings.conflict', 'Someone else saved changes to this project while you were editing. Their version is shown now.')}
        </Notice>
    );
}

function statusChipFor(form: ReturnType<typeof useSettingsForm>, t: ReturnType<typeof useTranslation>['t']): string | null {
    if (form.dirty) return t('project_home.settings.unsaved', 'Unsaved changes');
    if (form.saved) return t('project_home.settings.saved', 'Saved');
    return null;
}

/** The owner's cards: who may invite, who owns the project, archiving. */
function OwnerCards({ project, editorsCanInvite, onEditorsCanInvite, locked, readOnly, currentUserId }: {
    project: Project; editorsCanInvite: boolean; onEditorsCanInvite: (v: boolean) => void;
    locked: boolean; readOnly: boolean; currentUserId: string | null | undefined;
}) {
    const { t } = useTranslation();
    return (
        <>
            <Card title={t('project_home.settings.collab', 'Collaboration')}>
                <EditorsInviteToggle checked={editorsCanInvite} onChange={onEditorsCanInvite} disabled={locked || project.editorsCanInvite === undefined} />
            </Card>
            {!readOnly && <OwnershipCard project={project} currentUserId={currentUserId} />}
            <ArchiveCard project={project} />
        </>
    );
}

export default function SettingsTab({ projectId, project, role, currentUser, readOnly, onDeleted, onLeft, onDirtyChange }: WorkspaceTabProps & {
    onDeleted?: (id: string) => void;
    onLeft?: () => void;
    /** Tells the shell whether there are unsaved edits, so it can ask before leaving the tab. */
    onDirtyChange?: (dirty: boolean) => void;
}) {
    const { t } = useTranslation();
    const form = useSettingsForm(projectId, project, role);
    const { dirty } = form;
    useEffect(() => {
        onDirtyChange?.(dirty);
        return () => onDirtyChange?.(false);
    }, [dirty, onDirtyChange]);
    const canEdit = canEditProject(role) && !readOnly;
    const locked = !canEdit || form.saving;
    const { draft, edit } = form;

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-settings-tab">
            <StudioSectionHeader
                icon={Settings}
                title={t('project_home.tab.settings', 'Settings')}
                statusChip={statusChipFor(form, t)}
                primary={canEdit ? (
                    <PrimaryButton
                        onClick={() => form.save(t('project_home.create.name_required', 'Give the project a name.'))}
                        disabled={!form.dirty}
                        busy={form.saving}
                        data-testid="settings-save"
                    >
                        {form.saved && !form.dirty ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : <Save className="w-3.5 h-3.5" aria-hidden="true" />}
                        {t('project_home.settings.save', 'Save')}
                    </PrimaryButton>
                ) : undefined}
            />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-3xl mx-auto px-6 py-6 space-y-5">
                    {!canEdit && (
                        <Notice testId="settings-readonly">
                            {readOnly
                                ? t('project_home.archived.read_only', 'This project is archived and read-only. Restore it to change anything.')
                                : t('project_home.settings.readonly', 'Only editors and the owner can change these settings.')}
                        </Notice>
                    )}
                    {form.conflict && <ConflictNotice onRestore={form.restoreMine} />}
                    <ErrorText testId="settings-error">{form.error}</ErrorText>
                    <Card title={t('project_home.settings.about', 'About this project')}>
                        <div className="space-y-4">
                            <NameField value={draft.name} onChange={edit('name')} disabled={locked} />
                            <DescriptionField value={draft.description} onChange={edit('description')} disabled={locked} />
                            <div className="grid gap-5 sm:grid-cols-2">
                                <IconPicker value={draft.icon} onChange={edit('icon')} disabled={locked} />
                                <ColorSwatches value={draft.color} onChange={edit('color')} disabled={locked} />
                            </div>
                        </div>
                    </Card>
                    <Card title={t('project_home.settings.ai', 'AI in this project')}>
                        <div className="space-y-4">
                            <InstructionsField value={draft.customInstructions} onChange={edit('customInstructions')} disabled={locked} rows={8} />
                            <MemoryToggle checked={draft.extractMemories} onChange={edit('extractMemories')} disabled={locked} />
                        </div>
                    </Card>
                    <MuteCard project={project} />
                    {role === 'owner' && (
                        <OwnerCards project={project} editorsCanInvite={draft.editorsCanInvite} onEditorsCanInvite={edit('editorsCanInvite')} locked={locked} readOnly={!!readOnly} currentUserId={currentUser?.id} />
                    )}
                    <SettingsDanger project={project} role={role} currentUserId={currentUser?.id} onDeleted={onDeleted} onLeft={onLeft} />
                </div>
            </div>
        </div>
    );
}
