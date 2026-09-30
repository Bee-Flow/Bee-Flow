/**
 * One skill — the web's SkillDetail: ObjectHeader + TabBar over Method,
 * Examples, Test and Used by, editing the skill's structure in place with
 * an autosave.
 *
 * GET /api/skills/:id resolves against what the caller may actually see, so a
 * 404 here means "not yours to read". A shared skill this viewer may not edit
 * opens read-only (the server's `canEdit`, read fail-closed) — they can still
 * read every facet and switch it on for their own chats.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { AudienceSheet, QueryScreen, useOrgGroups, useUserRefresh } from '@/shared/patterns';
import { ObjectHeader } from '@/shared/ui';

import { ExamplesTab } from '../components/ExamplesTab';
import { MethodTab } from '../components/MethodTab';
import { SkillDeleteSheets } from '../components/SkillDeleteSheets';
import { SkillHeader, type SkillTab } from '../components/SkillHeader';
import { SkillNameSheet } from '../components/SkillNameSheet';
import { SkillUsageTab } from '../components/SkillUsageTab';
import { TestTab } from '../components/TestTab';
import { useSkill, useSkillUsage } from '../hooks/queries';
import { usePickerData } from '../hooks/usePickerData';
import { useSkillAi } from '../hooks/useSkillAi';
import { useSkillEditor } from '../hooks/useSkillEditor';
import { canDeleteSkill } from '../model/permissions';
import type { Skill } from '../model/types';

type Sheet = 'rename' | 'share' | 'delete' | null;

function SkillWorkspace({ skill, onRefresh }: { skill: Skill; onRefresh: () => unknown }) {
    const router = useRouter();
    const { user } = useAuth();
    const [tab, setTab] = useState<SkillTab>('method');
    const [sheet, setSheet] = useState<Sheet>(null);
    const editor = useSkillEditor(skill);
    const ai = useSkillAi(skill.id, editor);
    const picker = usePickerData(true);
    const usage = useSkillUsage(skill.id);
    const groups = useOrgGroups(sheet === 'share');
    const { draft, patch, locked } = editor;
    const deletable = canDeleteSkill(skill, user?.id, Boolean(user?.isAdmin));
    const onDelete = deletable ? () => setSheet('delete') : undefined;
    const common = useUserRefresh(onRefresh);

    return (
        <>
            <SkillHeader
                name={draft.name}
                saveState={editor.saveState}
                readOnly={locked}
                tab={tab}
                onTab={setTab}
                exampleCount={draft.examplesV2.length}
                usageCount={usage.data?.usage.length}
                improving={ai.improving}
                onImprove={() => void ai.improve()}
                onRename={() => setSheet('rename')}
                onShare={() => setSheet('share')}
                onDelete={onDelete}
            />
            {tab === 'method' ? (
                <MethodTab skill={skill} editor={editor} picker={picker} usage={usage.data} drafting={ai.drafting} onFillIn={ai.fillIn} {...common} />
            ) : null}
            {tab === 'examples' ? <ExamplesTab skillId={skill.id} editor={editor} {...common} /> : null}
            {tab === 'test' ? <TestTab skillId={skill.id} steps={draft.steps} readOnly={locked} /> : null}
            {tab === 'usage' ? (
                <SkillUsageTab usage={usage.data} isLoading={usage.isLoading} error={usage.error} onRetry={() => void usage.refetch()} onDelete={onDelete} />
            ) : null}

            <SkillNameSheet
                key={sheet === 'rename' ? 'open' : 'closed'}
                visible={sheet === 'rename'}
                name={draft.name}
                icon={draft.icon}
                onClose={() => setSheet(null)}
                onSave={(next) => patch(next, true)}
            />
            <AudienceSheet
                visible={sheet === 'share'}
                onClose={() => setSheet(null)}
                name={draft.name}
                value={{ isShared: draft.isShared, sharedGroups: draft.sharedGroups }}
                groups={groups.data ?? null}
                groupsLoading={groups.isLoading}
                onRetryGroups={() => void groups.refetch()}
                canShare={Boolean(skill.orgId)}
                onChange={(next) => patch(next, true)}
            />
            <SkillDeleteSheets skill={sheet === 'delete' ? skill : null} onCancel={() => setSheet(null)} onDeleted={() => router.back()} />
        </>
    );
}

export function SkillScreen({ skillId }: { skillId: string }) {
    const t = useTranslation();
    // The live row only: the editor seeds from it once, and a list row seeded
    // first and replaced later would autosave its older structure on the way out.
    const query = useSkill(skillId);
    const skill = query.data ?? undefined;
    return (
        <QueryScreen
            query={{
                data: skill,
                isLoading: query.isLoading,
                isError: query.isError && !skill,
                error: query.error ?? new Error(t('mobile.skills.not_available', 'This skill is not available to you.')),
                refetch: query.refetch,
            }}
            scroll={false}
            header={(data) => (data ? null : <ObjectHeader kind="skill" title="" backLabel={t('skills_studio.back', 'All skills')} />)}
            loadingLabel={t('mobile.skills.loading', 'Loading the skill')}
        >
            {(data) => <SkillWorkspace key={data.id} skill={data} onRefresh={() => query.refetch()} />}
        </QueryScreen>
    );
}
