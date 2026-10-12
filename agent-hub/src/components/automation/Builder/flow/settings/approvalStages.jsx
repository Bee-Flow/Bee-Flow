// The sequential approval chain editor (stages, seats, DirectoryOptions),
// extracted verbatim from SettingsForm.jsx. ApprovalFields (approvalEditors)
// renders ApprovalStagesEditor and shares DirectoryOptions.
import { ChevronDown, ChevronUp, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import {
    actionButtonClass, cardClass, controlSurfaceClass, FormRow, hintTextClass,
    listBadgeClass, subLabelClass,
} from './formPrimitives';
import {
    MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE, MAX_TOTAL_STAGE_SEATS,
    MAX_STAGE_NAME_LEN, MAX_STAGE_DESCRIPTION_LEN, STAGE_RULES,
    stageSeats, totalStageSeats, newStageKey,
} from './formState';
import ConditionBuilder from '../../mapping/ConditionBuilder';

/** A seat ({userId}|{groupId}|null) as the value one <select> encodes. */
function seatSelectValue(seat) {
    if (seat?.userId) return `u:${seat.userId}`;
    if (seat?.groupId) return `g:${seat.groupId}`;
    return '';
}
function decodeSeat(encoded) {
    if (!encoded) return null;
    return encoded.slice(0, 1) === 'u' ? { userId: encoded.slice(2) } : { groupId: encoded.slice(2) };
}

/**
 * The sequential approval chain: up to five named steps, asked one after
 * another, each with its own approvers, its own rule and an optional
 * condition.
 *
 * The one invariant this editor exists to protect is the stage KEY. Votes are
 * filed under it, so a stage that has already run must keep the key it ran
 * with — through a rename, through a reorder, through a stage being inserted
 * above it. Every operation here therefore moves the stage OBJECT (keys ride
 * along) and never derives a key from a position; only `+ Add stage` mints
 * one, and it takes the lowest `sN` the chain is not already using.
 */
function ApprovalStagesEditor({ stages, set, directory, onFocusField, previewSample, onDropStages, t }) {
    const setStages = (next) => set('stages', next);
    const patchStage = (i, patchRow) => setStages(stages.map((st, idx) => (idx === i ? { ...st, ...patchRow } : st)));
    // Swaps whole objects, so each stage's key travels with it — the vote
    // ledger keeps pointing at the same stage after a reorder.
    const moveStage = (i, delta) => {
        const j = i + delta;
        if (j < 0 || j >= stages.length) return;
        const next = stages.slice();
        [next[i], next[j]] = [next[j], next[i]];
        setStages(next);
    };
    const removeStage = (i) => {
        const next = stages.filter((_, idx) => idx !== i);
        // Dropping the last stage leaves the chain empty, which IS "no
        // stages" — fall back to the simple shape rather than persist a
        // half-mode the server would read as legacy anyway.
        if (!next.length) return onDropStages();
        setStages(next);
    };
    const addStage = () => setStages([...stages, {
        key: newStageKey(stages), name: '', description: '', approvers: [null], rule: 'all',
    }]);

    const used = totalStageSeats(stages);
    const budgetLeft = MAX_TOTAL_STAGE_SEATS - used;

    return (
        <FormRow
            label={t('automations.builder.approval_stages_label', 'Approval stages')}
            hint={t('automations.builder.approval_stages_hint', 'Up to 5 named steps, asked one after another. Only the current stage\'s people are asked, and only when their turn arrives — nobody further down the chain sees the request until it reaches them.')}
        >
            <div className="space-y-2">
                {stages.map((stage, i) => (
                    <StageRow
                        key={stage.key || `stage-${i}`}
                        stage={stage}
                        index={i}
                        total={stages.length}
                        budgetLeft={budgetLeft}
                        directory={directory}
                        onPatch={(patchRow) => patchStage(i, patchRow)}
                        onMove={(delta) => moveStage(i, delta)}
                        onRemove={() => removeStage(i)}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        t={t}
                    />
                ))}
                <div className="flex items-center justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2">
                        {stages.length < MAX_APPROVAL_STAGES && (
                            <button
                                type="button"
                                onClick={addStage}
                                className={actionButtonClass()}
                            >
                                <Plus size={12} /> {t('automations.builder.approval_stage_add', 'Add stage')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={onDropStages}
                            className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                        >
                            {t('automations.builder.approval_use_simple', 'Back to one round of approval')}
                        </button>
                    </div>
                    {/* The whole-chain budget, in the open: hitting it as a
                        server error after picking 31 people is the failure
                        this line exists to prevent. */}
                    <span className={budgetLeft <= 0 ? 'text-[11px] text-[var(--error)]' : subLabelClass()}>
                        {budgetLeft <= 0
                            ? t('automations.builder.approval_stage_budget_full', 'The chain is full at {max} approvers — remove one before adding another.', { max: String(MAX_TOTAL_STAGE_SEATS) })
                            : t('automations.builder.approval_stage_budget', '{used} of {max} approvers used across the chain', { used: String(used), max: String(MAX_TOTAL_STAGE_SEATS) })}
                    </span>
                </div>
            </div>
        </FormRow>
    );
}

/** One stage of the chain. */
function StageRow({ stage, index, total, budgetLeft, directory, onPatch, onMove, onRemove, onFocusField, previewSample, t }) {
    const seats = Array.isArray(stage.approvers) ? stage.approvers : [];
    const picked = stageSeats(stage);
    const rule = STAGE_RULES.includes(stage.rule) ? stage.rule : 'all';
    // A stage that ALREADY carries a condition always shows it — the opt-in
    // state only governs the empty case, so a chain rehydrated from the
    // server can never hide a condition behind a collapsed link.
    const hasWhen = typeof stage.when === 'string' && stage.when.length > 0;
    const [showWhen, setShowWhen] = useState(false);
    const whenOpen = showWhen || hasWhen;
    const position = t('automations.builder.approval_stage_position', 'Stage {n} of {m}', {
        n: String(index + 1), m: String(total),
    });

    const setSeat = (si, encoded) => onPatch({
        approvers: seats.map((seat, idx) => (idx === si ? decodeSeat(encoded) : seat)),
    });

    return (
        <div className={cardClass()}>
            <div className="flex items-center gap-1.5">
                <span className={listBadgeClass()}>{position}</span>
                <input
                    type="text"
                    value={stage.name || ''}
                    maxLength={MAX_STAGE_NAME_LEN}
                    onChange={(e) => onPatch({ name: e.target.value })}
                    placeholder={t('automations.builder.approval_stage_name_ph', 'Name this stage — Team lead, Finance…')}
                    aria-label={t('automations.builder.approval_stage_name_aria', 'Name of stage {n}', { n: String(index + 1) })}
                    className={controlSurfaceClass('flex-1 min-w-0 px-2 py-1 text-sm')}
                />
                <button
                    type="button"
                    onClick={() => onMove(-1)}
                    disabled={index === 0}
                    aria-label={t('automations.builder.approval_stage_up', 'Move stage {n} earlier', { n: String(index + 1) })}
                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition"
                >
                    <ChevronUp size={13} />
                </button>
                <button
                    type="button"
                    onClick={() => onMove(1)}
                    disabled={index === total - 1}
                    aria-label={t('automations.builder.approval_stage_down', 'Move stage {n} later', { n: String(index + 1) })}
                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30 transition"
                >
                    <ChevronDown size={13} />
                </button>
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('automations.builder.approval_stage_remove', 'Remove stage {n}', { n: String(index + 1) })}
                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                >
                    <Trash2 size={13} />
                </button>
            </div>

            <input
                type="text"
                value={stage.description || ''}
                maxLength={MAX_STAGE_DESCRIPTION_LEN}
                onChange={(e) => onPatch({ description: e.target.value })}
                placeholder={t('automations.builder.approval_stage_desc_ph', 'What are these approvers checking? (optional)')}
                aria-label={t('automations.builder.approval_stage_desc_aria', 'Description of stage {n}', { n: String(index + 1) })}
                className={controlSurfaceClass('w-full px-2 py-1 text-sm')}
            />

            <div className="space-y-1">
                {seats.map((seat, si) => (
                    <div key={si} className="flex items-center gap-1.5">
                        <select
                            value={seatSelectValue(seat)}
                            onChange={(e) => setSeat(si, e.target.value)}
                            aria-label={t('automations.builder.approval_stage_seat_aria', 'Stage {n}, approver {s}', { n: String(index + 1), s: String(si + 1) })}
                            className={controlSurfaceClass('flex-1 min-w-0 px-2 py-1 text-sm')}
                        >
                            <option value="">{t('automations.builder.approval_pick_seat', '— pick a person or group —')}</option>
                            <DirectoryOptions directory={directory} />
                        </select>
                        {seats.length > 1 && (
                            <button
                                type="button"
                                onClick={() => onPatch({ approvers: seats.filter((_, idx) => idx !== si) })}
                                aria-label={t('automations.builder.approval_stage_seat_remove', 'Remove approver {s} from stage {n}', { n: String(index + 1), s: String(si + 1) })}
                                className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--error)] transition"
                            >
                                <X size={12} />
                            </button>
                        )}
                    </div>
                ))}
                {seats.length < MAX_SEATS_PER_STAGE && budgetLeft > 0 && (
                    <button
                        type="button"
                        onClick={() => onPatch({ approvers: [...seats, null] })}
                        className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                    >
                        + {t('automations.builder.approval_stage_seat_add', 'Add approver')}
                    </button>
                )}
                {/* A stage nobody sits in cannot be saved (the server treats it
                    as broken shape, not as a half-finished draft), so say so
                    here rather than let the automation's save fail. */}
                {picked.length === 0 && (
                    <p className="text-[11px] text-[var(--error)]">
                        {t('automations.builder.approval_stage_empty', 'Pick at least one approver — a stage with nobody in it is not saved.')}
                    </p>
                )}
            </div>

            {picked.length >= 2 && (
                <div className="flex items-center gap-1.5">
                    <select
                        value={rule}
                        onChange={(e) => onPatch({ rule: e.target.value })}
                        aria-label={t('automations.builder.approval_stage_rule_aria', 'Decision rule for stage {n}', { n: String(index + 1) })}
                        className={controlSurfaceClass('flex-1 min-w-0 px-2 py-1 text-sm')}
                    >
                        <option value="all">{t('automations.builder.approval_rule_all', 'Everyone must approve')}</option>
                        <option value="first">{t('automations.builder.approval_rule_first', 'First to respond decides')}</option>
                        <option value="quorum">{t('automations.builder.approval_rule_quorum', 'At least N approvals')}</option>
                    </select>
                    {rule === 'quorum' && (
                        <select
                            value={String(Math.min(Math.max(Number(stage.quorum) || 2, 1), picked.length))}
                            onChange={(e) => onPatch({ quorum: Number(e.target.value) })}
                            aria-label={t('automations.builder.approval_stage_quorum_aria', 'Approvals needed in stage {n}', { n: String(index + 1) })}
                            className={controlSurfaceClass('shrink-0 px-2 py-1 text-sm')}
                        >
                            {Array.from({ length: picked.length }, (_, n) => n + 1).map(n => (
                                <option key={n} value={String(n)}>
                                    {t('automations.builder.approval_quorum_option', '{n} of {m}', { n: String(n), m: String(picked.length) })}
                                </option>
                            ))}
                        </select>
                    )}
                </div>
            )}

            {/* The condition is opt-in and collapsed by default: most stages
                always run, and five expression builders stacked open would
                bury the chain itself. */}
            {!whenOpen ? (
                <button
                    type="button"
                    onClick={() => setShowWhen(true)}
                    className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                >
                    + {t('automations.builder.approval_stage_when_add', 'Only ask this stage when…')}
                </button>
            ) : (
                <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                        <span className={subLabelClass()}>{t('automations.builder.approval_stage_when_label', 'Only ask this stage when')}</span>
                        <button
                            type="button"
                            onClick={() => { setShowWhen(false); onPatch({ when: '' }); }}
                            className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                        >
                            {t('automations.builder.approval_stage_when_clear', 'Always ask it')}
                        </button>
                    </div>
                    <ConditionBuilder
                        value={stage.when || ''}
                        onChange={(next) => onPatch({ when: next })}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        context="condition"
                        showSerialized={false}
                    />
                    <p className={hintTextClass()}>
                        {t('automations.builder.approval_stage_when_hint', 'Checked once, the moment the approval is created. A stage whose condition is not met is skipped — the chain moves straight on, and the skip stays visible in the approval\'s history.')}
                    </p>
                </div>
            )}
        </div>
    );
}

/**
 * The org directory as <option>s — shared by the single-approver select, the
 * panel seat rows, and the final sign-off picker, so the four lists can
 * never disagree about who exists.
 */
function DirectoryOptions({ directory }) {
    return (
        <>
            {(directory?.members || []).map(m => (
                <option key={m.id} value={`u:${m.id}`}>{m.name}</option>
            ))}
            {(directory?.groups || []).length > 0 && (
                <optgroup label="Groups">
                    {(directory?.groups || []).map(g => (
                        <option key={g.id} value={`g:${g.id}`}>{g.name}</option>
                    ))}
                </optgroup>
            )}
        </>
    );
}

export { ApprovalStagesEditor, DirectoryOptions };
