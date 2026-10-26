import { ArrowUpRight, Workflow } from 'lucide-react';
import { nOf } from '@/components/admin/Studio/KnowledgeStudio/plural';
import { cardRadius, kindTileStyle } from '@/components/shared/kindColors';
import { automation as automationStatus } from '@/components/shared/statusOf';
import { consequencesOf, openability, runCountOf, triggerConditionOf } from '../lib/meetingRules';
import type { TranslateFn, RuleRow, RunLabelInput, RuleFooterProps, RuleCardProps, TriggerCondition, Consequences } from './RulesPanel.types';

export const list = <T,>(v: T[] | null | undefined): T[] => (Array.isArray(v) ? v : []);

/**
 * "When a meeting tagged sales, support is finished" — the WHEN half.
 *
 * "… is finished" is the sentence of `meeting.processed`, and that appears only when THAT is the event. `meetingTriggersOf` deliberately filters on the PROVIDER and not on the event, so that a later `meeting.scheduled` automatically lands in the list — but then this sentence would tell the story of `meeting.processed` about every future event. Also reachable today: an unknown app_event event is a WARNING for the validator, not an error, so such a definition is saved, appears here, and never fires.
 */
export function conditionSentence(condition: TriggerCondition, t: TranslateFn): string | null {
    if (!condition) return null;
    const tags = list(condition.tags);
    if (!condition.onlyProcessed) {
        const events = list(condition.events).filter(Boolean);
        return events.length
            ? t('meetings.rules_when_event', 'When meeting notes fire {event}', { event: events.join(', ') })
            : t('meetings.rules_when_event_unknown', 'When meeting notes fire an event this card cannot name');
    }
    if (!tags.length) return t('meetings.rules_when_any', 'When any meeting note is finished');
    return nOf(
        t, 'meetings.rules_when_tagged', tags.length,
        'When a meeting tagged {tags} is finished',
        'When a meeting tagged any of {tags} is finished',
        { tags: tags.join(', ') },
    );
}

/**
 * The THEN half, as separate pieces (the card places ` · ` between them).
 *
 * Separate pieces and not a ready-made sentence: a list with "and" between is different in every language, and the separator here is the same character that the rest of this product places between facts (AutomationTile).
 */
export function consequenceParts(consequences: Consequences, t: TranslateFn): string[] {
    if (!consequences || consequences.readable === false) {
        return [t('meetings.rules_steps_unreadable', 'its steps could not be read')];
    }
    const parts: string[] = [];
    if (consequences.kb) parts.push(t('meetings.rules_does_kb', 'files it in a knowledge base'));
    if (consequences.notify) parts.push(t('meetings.rules_does_notify', 'sends a notification'));
    if (consequences.table) parts.push(t('meetings.rules_does_table', 'writes a row to a datatable'));
    if (consequences.other > 0) {
        parts.push(nOf(
            t, 'meetings.rules_does_other', consequences.other,
            '{count} more step this card cannot describe',
            '{count} more steps this card cannot describe',
        ));
    }
    if (!parts.length) {
        // "No steps" and "steps present, but none that this card counts as a
        // consequence" are different answers. Showing them together as "has no
        // steps" makes an author think his work was not saved.
        parts.push(consequences.steps > 0
            ? nOf(
                t, 'meetings.rules_does_internal', consequences.steps,
                '{count} step that only prepares data — nothing leaves the run',
                '{count} steps that only prepare data — nothing leaves the run',
            )
            : t('meetings.rules_does_nothing', 'nothing yet — this rule has no steps'));
    }
    return parts;
}

/**
 * The run line of one card, or NULL if there is nothing to say.
 *
 * NULL for a failed or still-running read — never a 0, because that would be a claim about runs we could not count. If the read succeeded and the automation is not in the facets, that is a real zero over a real range, and the sentence says so.
 */
export function runLabel({ facets, facetsError, automationId, hours }: RunLabelInput, t: TranslateFn): string | null {
    if (facetsError || !facets) return null;
    const n = runCountOf(facets, automationId);
    // NULL here means "nobody has counted" (no automationId map in the answer),
    // not "zero runs". Those were two different things with the same answer, and
    // the card made "no runs of yours" of it.
    if (n === null) return null;
    if (n === 0) {
        return t('meetings.rules_runs_none', 'no runs of yours in the last {hours} hours', { hours });
    }
    return nOf(
        t, 'meetings.rules_runs_mine', n,
        '{count} run of yours in the last {hours} hours',
        '{count} runs of yours in the last {hours} hours',
        { hours },
    );
}

/**
 * Active / paused / DRAFT — the shared three-state word list (`components/shared/statusOf.automation`, where `isDraft` beats `isActive`). Two states was a real error here: every rule that the "+ Rule" button of this panel creates comes out of the store as `is_active=FALSE, is_draft=TRUE`, and therefore got the word "Paused" — the same word as a finished rule that you deliberately switched off. The trigger bus skips a draft for a DIFFERENT reason (`dispatch.js` looks at `!isActive` AND at `isDraft`), and `crud.js` computes for the same reason `live = isActive && !isDraft`.
 */
function StateChip({ row, t }: { row: RuleRow; t: TranslateFn }) {
    // `undefined` is not "off": a row without these columns gets no chip.
    if (typeof row?.isActive !== 'boolean' && typeof row?.isDraft !== 'boolean') return null;
    const status = automationStatus(row);
    const style = status === 'live'
        ? { background: 'color-mix(in srgb, var(--success) 12%, transparent)', color: 'var(--success-ink)' }
        : status === 'draft'
            ? { background: 'color-mix(in srgb, var(--warning) 14%, transparent)', color: 'var(--warning-ink)' }
            : { background: 'var(--bg-tertiary)', color: 'var(--text-tertiary)' };
    const label = status === 'live'
        ? t('meetings.rules_active', 'Active')
        : status === 'draft'
            ? t('meetings.rules_draft', 'Draft')
            : t('meetings.rules_paused', 'Paused');
    return (
        <span
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0"
            style={style}
            title={status === 'draft' ? t('meetings.rules_draft_hint', 'Still a draft, so it does not run yet — open it and activate it.') : undefined}
        >
            {label}
        </span>
    );
}

/** The line under the sentence: whose runs they are, and whether the rule can be opened. */
function RuleFooter({ row, runs, open, onOpen, t }: RuleFooterProps) {
    return (
        <div className="flex items-center justify-between gap-2 min-w-0">
            <span className="text-[11px] truncate text-[var(--text-tertiary)]" data-testid="rule-runs">
                {runs || ''}
            </span>
            {open === 'ok' && typeof onOpen === 'function' ? (
                <button
                    type="button"
                    onClick={() => onOpen(row.id)}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium flex-shrink-0 text-[var(--accent-primary)]"
                    data-testid="rule-open"
                >
                    {t('meetings.rules_open', 'Open automation')}
                    <ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                </button>
            ) : open === 'foreign' ? (
                <span className="text-[11px] flex-shrink-0 text-[var(--text-tertiary)]" data-testid="rule-foreign">
                    {t('meetings.rules_someone_elses', 'Someone else’s rule')}
                </span>
            ) : null}
        </div>
    );
}

export function RuleCard({ row, facets, facetsError, hours, currentUserId, onOpen, t }: RuleCardProps) {
    const condition = triggerConditionOf(row?.definition);
    const parts = consequenceParts(consequencesOf(row?.definition), t);
    const runs = runLabel({ facets, facetsError, automationId: row?.id, hours }, t);

    const reprocessed = condition?.reprocessed === true
        ? t('meetings.trigger_reprocessed_again', 'Only a reprocess or a new summary')
        : (condition?.reprocessed === false ? t('meetings.trigger_reprocessed_first', 'Only a brand-new note') : null);
    const narrowing = [
        reprocessed,
        condition?.extra ? t('meetings.rules_extra_conditions', 'narrowed further by conditions this card cannot show') : null,
    ].filter(Boolean);

    const tile = kindTileStyle('automation', 28);

    return (
        <div
            className="flex flex-col gap-1.5 p-2.5 mb-1 border"
            style={{ borderRadius: cardRadius('automation'), borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' }}
            data-testid="rule-card"
        >
            <div className="flex items-start gap-2 min-w-0">
                <span style={tile.tile} aria-hidden="true"><Workflow style={tile.glyph} /></span>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span className="text-[13px] font-medium truncate text-[var(--text-primary)]">
                            {row?.title || t('meetings.rules_untitled', 'Untitled rule')}
                        </span>
                        <StateChip row={row} t={t} />
                    </div>
                    <p className="text-[11px] leading-snug text-[var(--text-secondary)]" data-testid="rule-sentence">
                        {conditionSentence(condition, t) || t('meetings.rules_when_unknown', 'This rule no longer starts on a meeting note')}
                        {' → '}
                        {parts.join(' · ')}
                    </p>
                    {narrowing.length > 0 && (
                        <p className="text-[11px] leading-snug text-[var(--text-tertiary)]" data-testid="rule-narrowing">
                            {narrowing.join(' · ')}
                        </p>
                    )}
                </div>
            </div>
            <RuleFooter row={row} runs={runs} open={openability(row, currentUserId)} onOpen={onOpen} t={t} />
        </div>
    );
}
