// Create a project: one focused form. Name first, the rest optional, and the
// instructions tucked behind a disclosure because most people add them later.

import { ChevronDown, ChevronRight, FolderPlus } from 'lucide-react';
import React, { useState } from 'react';
import { useCreateProject, type Project } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import {
    ColorSwatches, DescriptionField, IconPicker, InstructionsField, NameField,
} from './ProjectIdentityFields';
import { projectErrorText } from './projectErrorText';
import { DEFAULT_PROJECT_COLOR, DEFAULT_PROJECT_ICON, projectTileStyle } from './projectVisuals';
import { StudioSectionHeader } from './studioParts';
import { ErrorText, PrimaryButton, SecondaryButton } from './workspaceUi';

interface CreateDraft {
    name: string;
    description: string;
    icon: string;
    color: string;
    customInstructions: string;
}

const EMPTY_DRAFT: CreateDraft = {
    name: '',
    description: '',
    icon: DEFAULT_PROJECT_ICON,
    color: DEFAULT_PROJECT_COLOR,
    customInstructions: '',
};

function Preview({ draft }: { draft: CreateDraft }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-3 pb-4 border-b border-[var(--border-subtle)]">
            <span style={projectTileStyle(draft.color, 44)} aria-hidden="true">{draft.icon}</span>
            <div className="min-w-0">
                <p className="text-[15px] font-semibold text-[var(--text-primary)] truncate m-0">
                    {draft.name.trim() || t('project_home.create.preview_name', 'Your new project')}
                </p>
                <p className="text-[12px] text-[var(--text-tertiary)] m-0">
                    {t('project_home.create.preview_hint', 'Chats, documents, notes and knowledge — together in one place.')}
                </p>
            </div>
        </div>
    );
}

function InstructionsDisclosure({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <div>
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="inline-flex items-center gap-1 text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
                <Chevron className="w-3.5 h-3.5" aria-hidden="true" />
                {t('project_home.create.add_instructions', 'Add instructions for the AI (optional)')}
            </button>
            {open && (
                <div className="mt-3">
                    <InstructionsField value={value} onChange={onChange} disabled={disabled} rows={5} />
                </div>
            )}
        </div>
    );
}

export default function ProjectCreateForm({ onCancel, onCreated }: {
    onCancel: () => void;
    onCreated?: (project: Project) => void;
}) {
    const { t } = useTranslation();
    const create = useCreateProject();
    const [draft, setDraft] = useState<CreateDraft>(EMPTY_DRAFT);
    const [nameError, setNameError] = useState<string | null>(null);
    function set<K extends keyof CreateDraft>(key: K) {
        return (value: CreateDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
    }

    const submit = async (e: React.FormEvent) => {
        e.preventDefault();
        const name = draft.name.trim();
        if (!name) { setNameError(t('project_home.create.name_required', 'Give the project a name.')); return; }
        setNameError(null);
        try {
            const created = await create.mutateAsync({
                name,
                description: draft.description.trim(),
                icon: draft.icon,
                color: draft.color,
                customInstructions: draft.customInstructions,
                kind: 'workspace',
            });
            onCreated?.(created);
        } catch { /* the mutation's error is rendered below */ }
    };

    return (
        <div className="h-full flex flex-col min-h-0 bg-[var(--bg-primary)]" data-testid="project-create">
            <StudioSectionHeader
                icon={FolderPlus}
                title={t('project_home.create.title', 'New project')}
                onBack={onCancel}
                backLabel={t('project_home.back_to_projects', 'Back to projects')}
            />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <form onSubmit={submit} className="max-w-2xl mx-auto px-6 py-8" noValidate>
                    <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5 space-y-5">
                        <Preview draft={draft} />
                        <NameField value={draft.name} onChange={set('name')} autoFocus disabled={create.isPending} error={nameError} />
                        <DescriptionField value={draft.description} onChange={set('description')} disabled={create.isPending} />
                        <div className="grid gap-5 sm:grid-cols-2">
                            <IconPicker value={draft.icon} onChange={set('icon')} disabled={create.isPending} />
                            <ColorSwatches value={draft.color} onChange={set('color')} disabled={create.isPending} />
                        </div>
                        <InstructionsDisclosure value={draft.customInstructions} onChange={set('customInstructions')} disabled={create.isPending} />
                        <ErrorText testId="project-create-error">{create.error ? projectErrorText(t, create.error, t('project_home.create.failed', 'Could not create the project.')) : null}</ErrorText>
                        <div className="flex items-center justify-end gap-2 pt-1">
                            <SecondaryButton onClick={onCancel}>{t('project_home.cancel', 'Cancel')}</SecondaryButton>
                            <PrimaryButton type="submit" busy={create.isPending} data-testid="project-create-submit">
                                {t('project_home.create.submit', 'Create project')}
                            </PrimaryButton>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
