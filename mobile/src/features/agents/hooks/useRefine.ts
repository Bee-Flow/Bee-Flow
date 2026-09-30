/**
 * "Edit with AI" — the web's refine rail (builderSplit/refineActions.js), in
 * the same order:
 *
 *   1. POST /agents/wizard/refine with the agent as it is saved NOW, and the
 *      curated config the server is told to preserve;
 *   2. only after a good answer, POST /versions/:id/pre-refine — the undo
 *      point (a failed refine changes nothing and leaves none behind);
 *   3. mergeRefinedPlan folds the plan in without wiping apps, skills, model
 *      or knowledge; ONE save of the merged snapshot, persona included;
 *   4. a Done turn with what ACTUALLY changed (the merge's diff) and Undo,
 *      which restores the pre_refine version. One level deep.
 *
 * Refines run one at a time; the composer is busy while one is out.
 */

import { useState } from 'react';

import { ApiError } from '@/core/api/client';
import { describeError } from '@/core/api/errors';
import { currentLocale, useTranslation } from '@/core/i18n';
import { useTiers } from '@/features/chat';
import { INTEGRATION_CATALOG, useUserSettings } from '@/features/integrations';
import { useSkills } from '@/features/skills';

import { useRestoreVersion, useSaveAgent } from './editor';
import { refineAgent, snapshotBeforeRefine } from '../api/editorEndpoints';
import type { AgentDetail } from '../model/draft';
import { availableAgentApps, selectableTierKeys } from '../model/editorOptions';
import { draftFromMerged, refineContextOf, refineStateOf, resolvedSkillIds } from '../model/refineApply';
import { diffRefinedPlan, mergeRefinedPlan } from '../model/refineMerge';
import { withUndo, type RefineTurn } from '../model/refineTurns';

function isParseFailure(e: unknown): boolean {
    return e instanceof ApiError && (e.body as { reason?: unknown } | undefined)?.reason === 'plan_parse_failed';
}

/** What the merge needs to know about this person's world: apps, tiers, skills. */
function useRefineWorld() {
    const settings = useUserSettings();
    const tiers = useTiers('direct_chat');
    const skills = useSkills();
    const list = skills.data ?? [];
    return {
        // The first ask waits for these: a merge before them would drop every app but the built-ins.
        ready: !settings.isLoading && !tiers.isLoading && !skills.isLoading,
        tiers: tiers.data,
        appIds: availableAgentApps(INTEGRATION_CATALOG, settings.data?.orgEnabledIntegrations, settings.isSuccess).map((a) => a.id),
        tierKeys: selectableTierKeys(tiers.data),
        skillNames: new Map(list.map((s) => [s.id, s.name] as const)),
        skillIds: new Set(list.map((s) => s.id)),
    };
}

export function useRefine(agent: AgentDetail) {
    const t = useTranslation();
    const world = useRefineWorld();
    const save = useSaveAgent(agent.id);
    const restore = useRestoreVersion(agent.id);
    const [turns, setTurns] = useState<RefineTurn[]>([]);
    const [busy, setBusy] = useState(false);
    const push = (turn: RefineTurn) => setTurns((prev) => [...prev, turn]);
    const fail = (e: unknown) =>
        push({
            kind: 'error',
            text: isParseFailure(e)
                ? t('agent_wizard.builder.refine_parse_error', 'The assistant returned malformed output. Please try again.')
                : describeError(e).message,
        });

    const apply = async (text: string, tier: string) => {
        const first = turns.find((turn) => turn.kind === 'user');
        const ctx = refineContextOf(agent, world.skillNames);
        const answer = await refineAgent({
            prompt: first?.kind === 'user' ? first.text : text,
            plan: ctx.plan,
            current: ctx.current,
            refinement: text,
            modelTier: tier,
            locale: currentLocale(),
        });
        const undoVersionId = await snapshotBeforeRefine(agent.id);
        const { draft, state } = refineStateOf(agent);
        const merged = mergeRefinedPlan(state, answer.plan, answer.preserved, {
            availableIntegrationIds: world.appIds,
            selectableTierKeys: world.tierKeys,
            resolvedSkillIds: resolvedSkillIds(draft.config.attachedSkillIds, answer.plan, world.skillIds),
        });
        await save.mutateAsync({ draft: draftFromMerged(draft, merged), rev: agent.rev, persona: merged.persona });
        push({ kind: 'done', changes: diffRefinedPlan(state, merged), undoVersionId, undo: 'idle' });
    };

    const refine = async (text: string, tier: string) => {
        const trimmed = text.trim();
        if (!trimmed || busy) return;
        push({ kind: 'user', text: trimmed });
        setBusy(true);
        try {
            await apply(trimmed, tier);
        } catch (e) {
            fail(e);
        } finally {
            setBusy(false);
        }
    };

    const undo = async (index: number, versionId: string) => {
        setTurns((prev) => withUndo(prev, index, 'busy'));
        try {
            await restore.mutateAsync(versionId);
            setTurns((prev) => withUndo(prev, index, 'undone'));
        } catch {
            setTurns((prev) => withUndo(prev, index, 'failed'));
        }
    };

    return { turns, busy, refine, undo, tiers: world.tiers, ready: world.ready };
}
