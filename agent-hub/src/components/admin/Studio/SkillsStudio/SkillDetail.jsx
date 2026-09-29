import { Sparkles } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import useUsage from '../../../../hooks/useUsage';
import DangerZone from '../../../shared/DangerZone';
import SaveStatus from '../../../shared/SaveStatus';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { toast } from '../../../shared/Toast';
import UsedByTab, { usageHref } from '../../../shared/UsedByTab';
import VisibilityCapsule from '../../../shared/VisibilityCapsule';
import CanUseCard from './CanUseCard';
import ExamplesTab from './ExamplesTab';
import FillInCard from './FillInCard';
import OutputFieldsCard from './OutputFieldsCard';
import RulesEditor from './RulesEditor';
import SkillStepEditor from './SkillStepEditor';
import TestTab from './TestTab';
import { nOf } from '../KnowledgeStudio/plural';
import { buildSavePayload, draftOf, refKindKey } from './skillModel';
import { skillsApi } from './skillsApi';
import useSkillPickerData, { refOptionsOf } from './useSkillPickerData';

const INSTRUCTION_LIMIT = 4000;
const SAVE_DEBOUNCE_MS = 350;

/**
 * The kinds `GET /api/skills/:id/usage` scans — agents that attach the skill
 * and `ai_step` automations that name it (`skillStore.listSkillUsage`). They
 * are what a FAILED read did not check, and naming them is the difference
 * between "nothing uses this" and "I could not look".
 */
const USAGE_KINDS = Object.freeze(['agent', 'automation']);

/**
 * One skill (Skills artboards 1a and 1b).
 *
 * ── THE SAVE IS THE HARD PART, NOT THE LAYOUT ───────────────────────
 * Everything here autosaves 350ms after the last keystroke, which puts two
 * traps in the way and both are handled explicitly:
 *
 *   1. STRUCTURE, NEVER TEXT. S1's write precedence says a body carrying
 *      `workflow`/`rules`/`examples` makes the TEXT the source and re-parses
 *      the structure from it — which would re-mint every step id under a
 *      drag that is still in flight. `buildSavePayload` sends the structured
 *      facets only; the text columns are regenerated server-side, so a
 *      mobile client still reads exactly what it always read.
 *
 *   2. A 403 IS NOT A RETRY. A skill can be VISIBLE and not editable. S1
 *      answers `403 not_editable` rather than 404 for that case precisely
 *      so this loop can stop instead of re-sending every 350ms; the editor
 *      drops into read-only and says why, once.
 *
 * ── THE HEADER IS THE SHARED ONE ────────────────────────────────────
 * `StudioSectionHeader` with `kind="skill"`: the tile, the rename, the save
 * chip, the segment tabs and the capsule are the same row a knowledge base
 * or a table opens with. The primary action wears the ACCENT recipe
 * (`PRIMARY_ACTION_STYLE`), not the artboard's ink fill — the fill was
 * rejected for interactive elements.
 *
 * ── DELETE LIVES UNDER "USED BY" ────────────────────────────────────
 * Not in the list, not in a ⋯ menu: `DangerZone` sits at the bottom of the
 * tab that shows what deleting would break, and it confirms against the
 * SAME list the tab renders — the rows AND the kinds nobody could check.
 * Both, or the card contradicts the tab it is standing under. The server's 409 `in_use` guard stays the
 * authority — the dialog only ever confirms a list it has shown.
 */
export default function SkillDetail({
    skill,
    currentUserId = null,
    canManage = false,
    onBack,
    onSaved,
    onDeleted,
    onNavigate = null,
}) {
    const { t } = useTranslation();
    const [draft, setDraft] = useState(() => draftOf(skill));
    const [tab, setTab] = useState('method');
    const [saveState, setSaveState] = useState('idle');
    const [lastSavedAt, setLastSavedAt] = useState(null);
    const [capsuleOpen, setCapsuleOpen] = useState(false);
    const [improving, setImproving] = useState(false);
    const [drafting, setDrafting] = useState(false);
    // `canEdit` starts from the server's own answer and can only ever get
    // STRICTER (a 403 from a save). It never widens client-side.
    const [locked, setLocked] = useState(!skill.canEdit);
    const readOnly = locked;

    const { usage, unchecked, error: usageError } = useUsage('skill', skill.id);
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
    const uncheckedKinds = usageError ? USAGE_KINDS : unchecked;
    const picker = useSkillPickerData(true);
    const refOptions = useMemo(() => refOptionsOf(picker), [picker]);

    const draftRef = useRef(draft);
    const timerRef = useRef(null);
    const inflightRef = useRef(false);
    const dirtyRef = useRef(false);
    const aliveRef = useRef(true);
    useEffect(() => () => {
        aliveRef.current = false;
        if (timerRef.current) clearTimeout(timerRef.current);
    }, []);

    const flush = useCallback(async function doFlush() {
        if (!skill.id || !dirtyRef.current) return;
        if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
        if (inflightRef.current) {
            // A save is already on the wire. Come back right after it lands
            // instead of returning: dropping out here would silently lose
            // every keystroke typed during a slow save.
            timerRef.current = setTimeout(() => { timerRef.current = null; doFlush(); }, 120);
            return;
        }
        dirtyRef.current = false;
        inflightRef.current = true;
        try {
            await skillsApi.update(skill.id, buildSavePayload(draftRef.current));
            if (!aliveRef.current) return;
            setSaveState('saved');
            setLastSavedAt(new Date());
            onSaved?.({ id: skill.id, ...draftRef.current });
        } catch (e) {
            if (!aliveRef.current) return;
            setSaveState('error');
            if (e.status === 403 || e.code === 'not_editable') {
                // Stop the loop: this account may look but not touch.
                setLocked(true);
                dirtyRef.current = false;
                toast.error(t('skills_studio.err_readonly', 'You can see this skill but not change it.'));
            } else {
                // Anything else is worth another try on the next edit.
                dirtyRef.current = true;
                if (e.code === 'invalid_structure') {
                    toast.error(t('skills_studio.err_structure', 'Could not save “{field}” — check that field.', { field: e.field || '' }));
                }
            }
        } finally {
            inflightRef.current = false;
        }
    }, [skill.id, onSaved, t]);

    const queue = useCallback((immediate) => {
        if (!skill.id || locked) return;
        dirtyRef.current = true;
        setSaveState('saving');
        if (timerRef.current) clearTimeout(timerRef.current);
        if (immediate) { timerRef.current = null; flush(); }
        else timerRef.current = setTimeout(() => { timerRef.current = null; flush(); }, SAVE_DEBOUNCE_MS);
    }, [skill.id, locked, flush]);

    /**
     * Every edit goes through here: the ref the flush reads is updated
     * SYNCHRONOUSLY (so a save fired in the same tick sends the new value),
     * then the state, then the queue. Merging inside the setState updater
     * would put a side effect in a function React is allowed to call twice.
     */
    const patch = useCallback((next, immediate = false) => {
        const merged = { ...draftRef.current, ...next };
        draftRef.current = merged;
        setDraft(merged);
        queue(immediate);
    }, [queue]);

    const flushNow = () => { if (dirtyRef.current) flush(); };

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
            if (e.status === 403 || e.code === 'not_editable') setLocked(true);
            toast.error(e.message || t('skills_studio.err_improve', 'Could not improve this skill.'));
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
    const fillIn = async (sentence) => {
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
            toast.error(e.message || t('skills_studio.err_draft', 'Could not draft this skill.'));
        } finally {
            setDrafting(false);
        }
    };

    /**
     * A reference pill in a step opens the thing it points at — the routine,
     * the knowledge base, the table — through the SAME deep link the Used-by
     * table builds (`usageHref`), so a step's pill and a usage row cannot
     * disagree about where a thing lives.
     *
     * Null when there is nowhere to go: no `onNavigate` from the host, or a
     * ref kind with no detail page. SkillStepEditor then renders the pill as
     * plain text instead of a button that swallows the click.
     */
    const openRef = useMemo(() => {
        if (typeof onNavigate !== 'function') return null;
        return (ref) => {
            const href = usageHref({ kind: refKindKey(ref?.kind), id: ref?.id });
            if (href) onNavigate(href);
        };
    }, [onNavigate]);

    const remove = async (confirmBreaking) => {
        await skillsApi.remove(skill.id, confirmBreaking);
        onDeleted?.(skill.id);
    };

    const tabs = [
        { id: 'method', label: t('skills_studio.tab.method', 'Method') },
        { id: 'examples', label: t('skills_studio.tab.examples', 'Examples'), count: draft.examplesV2.length || undefined },
        { id: 'test', label: t('skills_studio.tab.test', 'Test') },
        // Always last: the tab the destructive action sends you to.
        // "Used by 0" is a claim about the world, so it comes off the read
        // that answered, never off one that failed.
        { id: 'usage', label: t('skills_studio.tab.usage', 'Used by'), count: knownUsage ? knownUsage.length : undefined },
    ];

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
                    <VisibilityCapsule
                        t={t}
                        agent={{ name: draft.name }}
                        variant="capsule"
                        anchored
                        confirmWidening
                        disabled={readOnly}
                        open={capsuleOpen}
                        onToggle={() => setCapsuleOpen(o => !o)}
                        onClose={() => setCapsuleOpen(false)}
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
                        onSetPersonal={() => { setCapsuleOpen(false); patch({ isShared: false, sharedGroups: [] }, true); }}
                        onSetEntireOrg={() => { setCapsuleOpen(false); patch({ isShared: true, sharedGroups: [] }, true); }}
                        onToggleGroup={(gid) => patch({
                            isShared: true,
                            sharedGroups: draftRef.current.sharedGroups.includes(gid)
                                ? draftRef.current.sharedGroups.filter(x => x !== gid)
                                : [...draftRef.current.sharedGroups, gid],
                        }, true)}
                    />
                )}
                primary={readOnly ? null : (
                    <button
                        type="button"
                        onClick={improve}
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
                )}
            />

            <div className="flex-1 min-h-0 overflow-y-auto px-7 py-6" onBlur={flushNow}>
                {readOnly && (
                    <p
                        className="text-xs mb-4 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] m-0"
                        style={{ color: 'var(--text-secondary)' }}
                        data-testid="skill-readonly"
                    >
                        {t('skills_studio.readonly', 'You can see this skill but not change it. Ask its owner, or an admin of the organisation it belongs to.')}
                    </p>
                )}

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
                        {canManage && !readOnly && (
                            <DangerZone
                                entityName={draft.name}
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
                                onDelete={remove}
                                kindLabel={t('skills_studio.kind', 'skill')}
                                currentUserId={currentUserId}
                                onNavigate={onNavigate}
                                openLabel={t('skills_studio.delete_title', 'Delete skill')}
                                requireName
                                notice={t('skills_studio.delete_notice', 'Agents that attach this skill lose the behaviour immediately.')}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/** The "Method" body: two cards on top, then steps beside the right rail. */
function MethodTab({ draft, patch, readOnly, refOptions, onOpenRef, picker, legacyAutomationId, usage, unchecked, onFillIn, drafting, t }) {
    const near = draft.instructions.length / INSTRUCTION_LIMIT > 0.9;
    const empty = draft.steps.length === 0 && draft.rulesV2.length === 0 && !draft.instructions.trim();
    return (
        <div className="flex flex-col gap-[18px] min-w-0">
            {empty && !readOnly && <FillInCard onFillIn={onFillIn} drafting={drafting} t={t} />}
            <div className="grid gap-3.5" style={{ gridTemplateColumns: '1fr 1fr' }}>
                <TextCard
                    label={t('skills_studio.what', 'What this skill does')}
                    value={draft.description}
                    readOnly={readOnly}
                    onChange={(description) => patch({ description })}
                    placeholder={t('skills_studio.field.description_placeholder', 'Short summary of what this skill does')}
                />
                <TextCard
                    label={t('skills_studio.when', 'When to use it')}
                    value={draft.instructions}
                    readOnly={readOnly}
                    muted
                    maxLength={INSTRUCTION_LIMIT}
                    onChange={(instructions) => patch({ instructions: instructions.slice(0, INSTRUCTION_LIMIT) })}
                    placeholder={t('skills_studio.field.instructions_placeholder', 'When and how the agent should use this skill (max 4000 chars)')}
                    hint={near
                        ? t('skills_studio.near_limit', '{count} characters left', { count: INSTRUCTION_LIMIT - draft.instructions.length })
                        : null}
                />
            </div>

            <div className="grid gap-3.5 min-w-0" style={{ gridTemplateColumns: 'minmax(0,1fr) 380px' }}>
                <SkillStepEditor
                    steps={draft.steps}
                    readOnly={readOnly}
                    refOptions={refOptions}
                    // `refOptions` is three arrays, and three arrays cannot say
                    // "that list 500'd". A step reference is a GRANT, so the
                    // menu needs the same three-way answer the card below uses.
                    listStatus={picker}
                    onOpenRef={onOpenRef}
                    onChange={(steps) => patch({ steps })}
                />
                <div className="flex flex-col gap-4 min-w-0">
                    <RulesEditor
                        rules={draft.rulesV2}
                        readOnly={readOnly}
                        onChange={(rulesV2) => patch({ rulesV2 })}
                    />
                    <OutputFieldsCard
                        outputSchema={draft.outputSchema}
                        readOnly={readOnly}
                        onChange={(outputSchema) => patch({ outputSchema })}
                    />
                    <CanUseCard
                        enabledIntegrations={draft.enabledIntegrations}
                        allowedAutomationIds={draft.allowedAutomationIds}
                        knowledgeBaseIds={draft.knowledgeBaseIds}
                        dynamicActivation={draft.dynamicActivation}
                        legacyAutomationId={legacyAutomationId}
                        automations={picker.automations}
                        knowledgeBases={picker.knowledgeBases}
                        // The same reading of "did those lists arrive" the
                        // pickers above use, so the card can tell an empty
                        // org from a list it never managed to read.
                        listStatus={picker}
                        readOnly={readOnly}
                        onChange={(next) => patch(next, true)}
                    />
                    <UsedByNote usage={usage} unchecked={unchecked} t={t} />
                </div>
            </div>
        </div>
    );
}

/**
 * The standing note at the bottom of the right rail (artboard 1a): who uses
 * this, and the one sentence that makes editing here feel safe — "a change
 * applies everywhere at once".
 *
 * It only claims a count it HAS, and there are TWO ways not to have one:
 * the list is still loading, or the read FAILED. `knownUsage` above folds
 * both into null before they get here, so this stays one question — and
 * "No agent or automation uses this skill yet" is never printed off a read
 * that never answered. The Used-by tab is where a failed read gets its own
 * sentence.
 */
function UsedByNote({ usage, unchecked = [], t }) {
    if (!Array.isArray(usage)) return null;
    // A 200 can ALSO be a "not known": the server answers `{ usage, unchecked }`
    // and a kind named there is one nobody scanned. `knownUsage` folds only the
    // ERROR into null, so that 200 arrived here looking like a complete answer —
    // and this is the sentence that would then be wrong.
    const incomplete = Array.isArray(unchecked) && unchecked.length > 0;
    if (incomplete) {
        return (
            <p
                className="mt-auto px-3 py-2.5 rounded-[10px] text-[11px] leading-4 m-0"
                style={{ background: 'var(--bg-secondary)', color: 'var(--warning-ink, var(--warning))' }}
                data-testid="skill-usedby-note"
                data-incomplete="true"
            >
                {t('skills_studio.usage.partial', 'Not everything could be checked, so this list may be short. A change here applies everywhere at once.')}
            </p>
        );
    }
    return (
        <p
            className="mt-auto px-3 py-2.5 rounded-[10px] text-[11px] leading-4 m-0"
            style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            data-testid="skill-usedby-note"
        >
            {usage.length === 0
                ? t('skills_studio.usage.empty', 'No agent or automation uses this skill yet.')
                : nOf(
                    t, 'skills_studio.usage.note', usage.length,
                    'Used by {count} agent or automation. A change here applies everywhere at once.',
                    'Used by {count} agents and automations. A change here applies everywhere at once.',
                )}
        </p>
    );
}

function TextCard({ label, value, onChange, readOnly, placeholder, muted = false, hint = null, maxLength }) {
    return (
        <label className="flex flex-col gap-1.5 min-w-0">
            <span className="text-xs font-medium text-[var(--text-primary)]">{label}</span>
            <textarea
                value={value}
                readOnly={readOnly}
                rows={3}
                maxLength={maxLength}
                onChange={(e) => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full resize-y rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2.5 text-[13px] leading-[18px] outline-none placeholder:text-[var(--text-tertiary)]"
                style={{ color: muted ? 'var(--text-secondary)' : 'var(--text-primary)' }}
            />
            {hint && <span className="text-xs" style={{ color: 'var(--warning-ink)' }}>{hint}</span>}
        </label>
    );
}
