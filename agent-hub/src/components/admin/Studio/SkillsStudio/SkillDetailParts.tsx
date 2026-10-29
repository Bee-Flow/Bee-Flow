import { Sparkles } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import DangerZone from '@/components/shared/DangerZone';
import { PRIMARY_ACTION_STYLE } from '@/components/shared/StudioSectionHeader';
import UsedByTab, { usageHref } from '@/components/shared/UsedByTab';
import VisibilityCapsule from '@/components/shared/VisibilityCapsule';
import { refKindKey } from './skillModel';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { UsageRow } from '@/hooks/useUsage';
import type { SkillDraft, StepRef } from './skillModel.types';
import type { PickerData } from './useSkillPickerData';

/**
 * The pieces of the skill editor around its tabs: the reading of "who uses
 * this", the tab list, the reference opener, the sharing capsule, the
 * improve button, the read-only note and the Used-by tab. Moved out of
 * SkillDetail.tsx verbatim.
 */

/**
 * The kinds `GET /api/skills/:id/usage` scans — agents that attach the skill
 * and `ai_step` automations that name it (`skillStore.listSkillUsage`). They
 * are what a FAILED read did not check, and naming them is the difference
 * between "nothing uses this" and "I could not look".
 */
const USAGE_KINDS = Object.freeze(['agent', 'automation']);

export function usageReading(usage: UsageRow[] | null, unchecked: string[], usageError: string | null) {
    // ONE reading of "who uses this", used by everything that makes a CLAIM
    // about it. A failed read leaves `usage` at [] with an `error` beside it
    // (useUsage's contract, so nobody mistakes it for "nothing depends on
    // this") — here that collapses to null, the value every consumer already
    // treats as "not known". The Used-by TAB keeps the raw pair: it is the
    // one surface whose job is to say the read failed.
    const knownUsage = usageError ? null : usage;
    /**
     * Which kinds the tab may NOT speak for.
     *
     * A read that failed checked nothing, so both kinds this skill can be
     * used by are unchecked; a read that answered passes on whatever the
     * SERVER itself could not check (`{ unchecked: [...] }`) instead of
     * dropping it at the client boundary. Handed a non-empty list, UsedByTab
     * swaps its confident empty sentence and its dashed "not used by
     * anything" pill for the narrower pair and names the kinds — which is
     * exactly why the explicit `emptyText` below is withheld in that case:
     * an `emptyText` always wins, and this one is the claim in question.
     */
    const uncheckedKinds: readonly string[] = usageError ? USAGE_KINDS : unchecked;
    return { knownUsage, uncheckedKinds };
}

export function skillTabs(t: TranslateFn, exampleCount: number, knownUsage: UsageRow[] | null) {
    return [
        { id: 'method', label: t('skills_studio.tab.method', 'Method') },
        { id: 'examples', label: t('skills_studio.tab.examples', 'Examples'), count: exampleCount || undefined },
        { id: 'test', label: t('skills_studio.tab.test', 'Test') },
        // Always last: the tab the destructive action sends you to.
        // "Used by 0" is a claim about the world, so it comes off the read
        // that answered, never off one that failed.
        { id: 'usage', label: t('skills_studio.tab.usage', 'Used by'), count: knownUsage ? knownUsage.length : undefined },
    ];
}

/**
 * A reference pill in a step opens the thing it points at — the automation,
 * the knowledge base, the table — through the SAME deep link the Used-by
 * table builds (`usageHref`), so a step's pill and a usage row cannot
 * disagree about where a thing lives.
 *
 * Null when there is nowhere to go: no `onNavigate` from the host, or a
 * ref kind with no detail page. SkillStepEditor then renders the pill as
 * plain text instead of a button that swallows the click.
 */
export function refOpener(onNavigate: ((to: string) => void) | null) {
    if (typeof onNavigate !== 'function') return null;
    return (ref: StepRef) => {
        const href = usageHref({ kind: refKindKey(ref?.kind), id: ref?.id });
        if (href) onNavigate(href);
    };
}

export interface SkillCapsuleProps {
    draft: SkillDraft;
    draftRef: RefObject<SkillDraft>;
    readOnly: boolean;
    open: boolean;
    setOpen: Dispatch<SetStateAction<boolean>>;
    picker: PickerData;
    patch: (next: Partial<SkillDraft>, immediate?: boolean) => void;
}

export function SkillCapsule({ draft, draftRef, readOnly, open, setOpen, picker, patch }: SkillCapsuleProps) {
    const { t } = useTranslation();
    return (
        <VisibilityCapsule
            t={t}
            agent={{ name: draft.name }}
            variant="capsule"
            anchored
            confirmWidening
            disabled={readOnly}
            open={open}
            onToggle={() => setOpen(o => !o)}
            onClose={() => setOpen(false)}
            isPublished={draft.isShared}
            sharedGroups={draft.sharedGroups}
            orgGroups={picker.orgGroups}
            // /auth/groups can fail like any other read, and the
            // capsule's own empty line ("No groups in this
            // organisation yet.") is exactly the claim the rest of
            // this screen spends its width avoiding. The gap goes to
            // the component that SHOWS the list.
            groupsUnavailable={picker.loaded && picker.unavailable.includes('groups')}
            onRetryGroups={picker.reload}
            onSetPersonal={() => { setOpen(false); patch({ isShared: false, sharedGroups: [] }, true); }}
            onSetEntireOrg={() => { setOpen(false); patch({ isShared: true, sharedGroups: [] }, true); }}
            onToggleGroup={(gid) => patch({
                isShared: true,
                sharedGroups: draftRef.current.sharedGroups.includes(gid)
                    ? draftRef.current.sharedGroups.filter(x => x !== gid)
                    : [...draftRef.current.sharedGroups, gid],
            }, true)}
        />
    );
}

export function ImproveButton({ improving, onImprove }: { improving: boolean; onImprove: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onImprove}
            disabled={improving}
            data-testid="skill-improve"
            className="h-8 px-3 rounded-[10px] text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
            style={PRIMARY_ACTION_STYLE}
        >
            <Sparkles size={13} aria-hidden="true" />
            {improving
                ? t('skills_studio.improving', 'Improving…')
                : t('skills_studio.improve', 'Improve with AI')}
        </button>
    );
}

export function ReadOnlyNote() {
    const { t } = useTranslation();
    return (
        <p
            className="text-xs mb-4 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] m-0 text-[var(--text-secondary)]"
            data-testid="skill-readonly"
        >
            {t('skills_studio.readonly', 'You can see this skill but not change it. Ask its owner, or an admin of the organisation it belongs to.')}
        </p>
    );
}

export interface SkillUsageTabProps {
    name: string;
    usage: UsageRow[] | null;
    usageError: string | null;
    uncheckedKinds: readonly string[];
    currentUserId: string | null;
    onNavigate: ((to: string) => void) | null;
    canDelete: boolean;
    onDelete: (confirmBreaking: boolean) => Promise<void>;
}

export function SkillUsageTab({ name, usage, usageError, uncheckedKinds, currentUserId, onNavigate, canDelete, onDelete }: SkillUsageTabProps) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-6 max-w-3xl">
            <UsedByTab
                rows={usage}
                error={usageError}
                unchecked={uncheckedKinds}
                currentUserId={currentUserId}
                onNavigate={onNavigate}
                emptyText={uncheckedKinds.length
                    ? undefined
                    : t('skills_studio.usage.empty', 'No agent or automation uses this skill yet.')}
            />
            {canDelete && (
                <DangerZone
                    entityName={name}
                    // `usageError ? [] : usage`, NOT `knownUsage`.
                    // The two "not known" cases want opposite
                    // answers here: a read still in flight keeps the
                    // spinner (null), a read that FAILED must not
                    // spin forever over an answer that is never
                    // coming — it is an empty list with every kind
                    // unchecked, which is what makes the card print
                    // the narrow line instead of "can be deleted
                    // without breaking anything else".
                    usage={usageError ? [] : usage}
                    // The SAME list the tab two elements up shows.
                    // Withholding it here was the whole gap: the tab
                    // said "Could not be checked: automations" and
                    // the card directly under it offered the delete
                    // as safe.
                    unchecked={uncheckedKinds}
                    onDelete={onDelete}
                    kindLabel={t('skills_studio.kind', 'skill')}
                    currentUserId={currentUserId}
                    onNavigate={onNavigate}
                    openLabel={t('skills_studio.delete_title', 'Delete skill')}
                    requireName
                    notice={t('skills_studio.delete_notice', 'Agents that attach this skill lose the behaviour immediately.')}
                />
            )}
        </div>
    );
}
