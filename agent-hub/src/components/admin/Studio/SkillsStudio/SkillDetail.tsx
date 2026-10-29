import { useMemo, useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import useUsage from '@/hooks/useUsage';
import SaveStatus from '@/components/shared/SaveStatus';
import StudioSectionHeader from '@/components/shared/StudioSectionHeader';
import { toast } from '@/components/shared/Toast';
import ExamplesTab from './ExamplesTab';
import TestTab from './TestTab';
import { draftOf } from './skillModel';
import { skillsApi } from '@/api/skillsApi';
import useSkillPickerData, { refOptionsOf } from './useSkillPickerData';
import { ImproveButton, ReadOnlyNote, SkillCapsule, SkillUsageTab, refOpener, skillTabs, usageReading } from './SkillDetailParts';
import { MethodTab } from './SkillMethodTab';
import { useSkillAutosave } from './useSkillAutosave';
import type { JsonResourceError } from '@/api/client';
import type { SkillDetailProps } from './SkillDetail.types';

export default function SkillDetail({
    skill,
    currentUserId = null,
    canManage = false,
    onBack,
    onSaved,
    onDeleted,
    onNavigate = null,
}: SkillDetailProps) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(() => draftOf(skill));
    const [tab, setTab] = useState('method');
    const [saveState, setSaveState] = useState('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const [capsuleOpen, setCapsuleOpen] = useState(false);
    const [improving, setImproving] = useState(false);
    const [drafting, setDrafting] = useState(false);
    // `canEdit` starts from the server's own answer and can only ever get
    // STRICTER (a 403 from a save). It never widens client-side.
    const [locked, setLocked] = useState(!skill.canEdit);
    const readOnly = locked;

    const { usage, unchecked, error: usageError } = useUsage('skill', skill.id);
    const { knownUsage, uncheckedKinds } = usageReading(usage, unchecked, usageError);
    const picker = useSkillPickerData(true);
    const refOptions = useMemo(() => refOptionsOf(picker), [picker]);

    const { draftRef, dirtyRef, flush, patch, flushNow } = useSkillAutosave({
        skillId: skill.id, initialDraft: draft, locked, onSaved, t, setDraft, setSaveState, setLastSavedAt, setLocked,
    });

    /**
     * "Improve with AI". The SERVER persists the rewrite and answers with
     * the stored row — this handler never queues a save, so an endpoint that
     * only suggested would leave the rewrite in state and lose it on the
     * next navigation. Adopting the stored row also means the editor and the
     * database cannot show different skills.
     *
     * A pending keystroke is flushed first: the rewrite is built from what
     * the SERVER has, so an unsaved edit would otherwise be rewritten away.
     */
    const improve = async () => {
        if (improving || readOnly) return;
        setImproving(true);
        try {
            if (dirtyRef.current) await flush();
            const body = await skillsApi.improve(skill.id);
            const next = draftOf(body?.skill || body);
            draftRef.current = next;
            setDraft(next);
            setSaveState('saved');
            setLastSavedAt(new Date());
            toast.success(t('skills_studio.improved', 'Updated with AI.'));
            onSaved?.({ id: skill.id, ...next });
        } catch (e) {
            if ((e as JsonResourceError).status === 403 || (e as JsonResourceError).code === 'not_editable') setLocked(true);
            toast.error((e as Error).message || t('skills_studio.err_improve', 'Could not improve this skill.'));
        } finally {
            setImproving(false);
        }
    };

    /**
     * "Let AI fill it in" — one sentence to a whole skill, offered only on a
     * skill that is still EMPTY. The result is a draft, not a save: it goes
     * through `patch`, so the same autosave that carries every keystroke
     * carries it, and the person sees it in the editor before it is theirs.
     * (The Skills TABLE deliberately does not do this: a row that rewrites a
     * skill with nothing on screen to compare against is not the shape that
     * action wants — see `index.jsx`.)
     */
    const fillIn = async (sentence: string) => {
        if (drafting || readOnly || !sentence.trim()) return;
        setDrafting(true);
        try {
            const body = await skillsApi.draft(sentence.trim());
            const proposal = body?.draft;
            if (!proposal) throw new Error(t('skills_studio.err_draft', 'Could not draft this skill.'));
            patch({
                name: proposal.name || draftRef.current.name,
                description: proposal.description ?? draftRef.current.description,
                instructions: proposal.instructions ?? draftRef.current.instructions,
                steps: Array.isArray(proposal.steps) ? proposal.steps : draftRef.current.steps,
                rulesV2: Array.isArray(proposal.rulesV2) ? proposal.rulesV2 : draftRef.current.rulesV2,
                examplesV2: Array.isArray(proposal.examplesV2) ? proposal.examplesV2 : draftRef.current.examplesV2,
                outputSchema: proposal.outputSchema ?? draftRef.current.outputSchema,
            }, true);
            toast.success(t('skills_studio.drafted', 'Filled in with AI. Read it through before you rely on it.'));
        } catch (e) {
            toast.error((e as Error).message || t('skills_studio.err_draft', 'Could not draft this skill.'));
        } finally {
            setDrafting(false);
        }
    };

    const openRef = useMemo(() => refOpener(onNavigate), [onNavigate]);

    const remove = async (confirmBreaking: boolean) => {
        await skillsApi.remove(skill.id, confirmBreaking);
        onDeleted?.(skill.id);
    };

    const tabs = skillTabs(t, draft.examplesV2.length, knownUsage);

    return (
        <div className="h-full flex flex-col min-w-0 min-h-0" data-testid="skill-detail">
            <StudioSectionHeader
                kind="skill"
                title={draft.name}
                onRename={readOnly ? undefined : (name) => patch({ name }, true)}
                statusChip={<SaveStatus saveState={saveState} lastSavedAt={lastSavedAt} onRetry={flush} showWhenIdle />}
                tabs={tabs}
                activeTab={tab}
                onTab={setTab}
                onBack={onBack}
                backLabel={t('skills_studio.back', 'All skills')}
                capsule={(
                    <SkillCapsule
                        draft={draft}
                        draftRef={draftRef}
                        readOnly={readOnly}
                        open={capsuleOpen}
                        setOpen={setCapsuleOpen}
                        picker={picker}
                        patch={patch}
                    />
                )}
                primary={readOnly ? null : <ImproveButton improving={improving} onImprove={improve} />}
            />

            <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6" onBlur={flushNow}>
                {readOnly && <ReadOnlyNote />}

                {tab === 'method' && (
                    <MethodTab
                        draft={draft}
                        patch={patch}
                        readOnly={readOnly}
                        onFillIn={fillIn}
                        drafting={drafting}
                        refOptions={refOptions}
                        onOpenRef={openRef}
                        picker={picker}
                        legacyAutomationId={skill.automationId || null}
                        usage={knownUsage}
                        unchecked={uncheckedKinds}
                        t={t}
                    />
                )}

                {tab === 'examples' && (
                    <ExamplesTab
                        skillId={skill.id}
                        examples={draft.examplesV2}
                        rules={draft.rulesV2}
                        readOnly={readOnly}
                        onChange={(examplesV2) => patch({ examplesV2 })}
                    />
                )}

                {tab === 'test' && (
                    <TestTab skillId={skill.id} steps={draft.steps} onNavigate={onNavigate} readOnly={readOnly} />
                )}

                {tab === 'usage' && (
                    <SkillUsageTab
                        name={draft.name}
                        usage={usage}
                        usageError={usageError}
                        uncheckedKinds={uncheckedKinds}
                        currentUserId={currentUserId}
                        onNavigate={onNavigate}
                        canDelete={canManage && !readOnly}
                        onDelete={remove}
                    />
                )}
            </div>
        </div>
    );
}
