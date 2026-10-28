import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { summariseCardFooter } from './cardFooter';
import type { CardFooterSummary } from './cardFooter';
import useTranslation from '@/hooks/useTranslation';
import type { TranslateFn } from '@/hooks/useTranslation';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

/**
 * The footer of an agent card in the overview (A5, part D).
 *
 * One line under the card, in three forms:
 *
 *   ⚠ Answers from memory — connect a knowledge base
 *   312 conversations · also in 2 automations, 1 app
 *   Only you · 4 conversations
 *
 * "Test" is deliberately NOT in there. This product has a first-class notion of testing, with its own tables and its own counter (`agent_tests` / `agent_test_runs`, stores/agent/agentTests.js), and that is what the Test tab of the same agent counts. This count comes from `agent_conversations` — ordinary conversations. Two numbers that have nothing to do with each other may not carry the same word.
 *
 * Which of the three it becomes is decided by `summariseCardFooter` next door; this file only chooses the words. The warning comes from the server (`grounding.verdict`, from core/agentRuntime/agentGrounding.js) and is not recalculated here — see the header of cardFooter.ts for why that is the whole design.
 *
 * ── ONE LINE, SO THE WARNING DISPLACES THE COUNTS ───────────────────
 * Of the three forms, the warning is the only one that ASKS for something. Set next to "312 conversations" it would take on the air of a footnote to a success story; so it stands alone. The counts are not gone — they are on the "Used by" tab of the same agent.
 *
 * ── UNREADABLE GETS WORDS, NOT A ZERO ──────────────────────────────
 * "312 conversations" and "the conversation count could not be read" are different sentences. The second is the one you get when `stats: null` comes back, and it may never be read as the first with a 0. The same goes for "used by": a kind in `usage.partial` is not zero; it gets its own half sentence.
 */

/**
 * The COUNTED name of a consumer kind — singular and plural.
 *
 * A `switch` with LITERAL keys, for the same reason that DeleteBlockedNotice.jsx writes down: the i18n guard reads call sites, so a key that is composed from a variable is invisible to it and can travel along unnoticed until it turns up in a language that nobody tested. (This comment deliberately no longer gives an example call: the guard reads the raw file text and did not exclude comments, so an illustrative `nOf(...)` above demanded a ghost key that must never exist — and the next reader would have put it into the dictionaries.)
 *
 * These are not the keys of that dialog: `agent_usage.kind_*` are HEADINGS ("Automations"), which have no singular and cannot get one in a counted phrase without giving something else a different meaning. For the phrase "could not check: …" they are exactly right, and that is where they are reused below.
 *
 * A kind that the server adds later falls back on its own raw name: ugly and honest beats a label that quietly claims something else.
 */
function usedByPhrase(t: TranslateFn, kind: string, n: number | null) {
    switch (kind) {
        case 'task': return nOf(t, 'agent_studio.card.n_task', n, '{count} scheduled task', '{count} scheduled tasks');
        case 'cowork': return nOf(t, 'agent_studio.card.n_cowork', n, '{count} Cowork schedule', '{count} Cowork schedules');
        case 'support': return nOf(t, 'agent_studio.card.n_support', n, '{count} support inbox', '{count} support inboxes');
        case 'automation': return nOf(t, 'agent_studio.card.n_automation', n, '{count} automation', '{count} automations');
        case 'app': return nOf(t, 'agent_studio.card.n_app', n, '{count} app', '{count} apps');
        case 'webpage': return nOf(t, 'agent_studio.card.n_webpage', n, '{count} webpage', '{count} webpages');
        default: return `${n} ${kind}`;
    }
}

/** De kopjesnaam van een soort, voor "could not check: …". */
function kindHeading(t: TranslateFn, kind: string) {
    switch (kind) {
        case 'task': return t('agent_usage.kind_task', 'Scheduled tasks');
        case 'cowork': return t('agent_usage.kind_cowork', 'Cowork schedules');
        case 'support': return t('agent_usage.kind_support', 'Support inboxes');
        case 'automation': return t('agent_usage.kind_automation', 'Automations');
        case 'app': return t('agent_usage.kind_app', 'Apps');
        case 'webpage': return t('agent_usage.kind_webpage', 'Webpages');
        default: return kind;
    }
}

/**
 * The half sentences after the count: what the agent is used by, and what nobody could check. Both may be missing, and neither may read as zero — a list without `?usage=1` yields nothing here, and that is something other than "used by nothing".
 */
function usageParts(t: TranslateFn, footer: CardFooterSummary) {
    const parts: string[] = [];
    if (footer.usedBy.length > 0) {
        const items = footer.usedBy.map(u => usedByPhrase(t, u.kind, u.count)).join(', ');
        parts.push(t('agent_studio.card.also_in', 'also in {items}', { items }));
    }
    if (footer.unchecked.length > 0) {
        const kinds = footer.unchecked.map(k => kindHeading(t, k)).join(', ');
        parts.push(t('agent_studio.card.unchecked', 'could not check: {kinds}', { kinds }));
    }
    return parts;
}

export interface AgentCardFooterProps {
    /** Één rij van GET /agents/all. */
    agent?: unknown;
    /** Who is looking — without this, "Only you" cannot be true and that form does not appear. */
    viewerId?: string | null;
}

export default function AgentCardFooter({ agent, viewerId = null }: AgentCardFooterProps) {
    const { t } = useTranslation();
    const footer = summariseCardFooter(agent, viewerId);

    // `<span className="block">`, not a `<p>`. The footer hangs inside the card button of AgentCard.jsx, and a `<button>` only takes phrasing content — that is why every child there is a span.
    if (footer.variant === 'ungrounded') {
        return (
            <span
                className="flex items-center gap-1.5 text-xs text-[var(--warning)]"
                data-testid="agent-card-footer"
                data-variant="ungrounded"
            >
                <AlertTriangle size={12} aria-hidden="true" className="flex-shrink-0" />
                <span>{t('agent_studio.card.ungrounded', 'Answers from memory — connect a knowledge base')}</span>
            </span>
        );
    }

    // The count. Three answers: not requested (then the footer says nothing about it — /agents/system does not calculate counts), not read (that gets words), or a number that the server counted (a 0 included).
    const unreadable = footer.statsAsked && footer.conversations === null;
    const countPart = !footer.statsAsked
        ? null
        : (unreadable
            ? t('agent_studio.card.conversations_unreadable', 'The conversation count could not be read')
            : nOf(t, 'agent_studio.card.n_conversations', footer.conversations, '{count} conversation', '{count} conversations'));

    const parts = [
        ...(footer.variant === 'private' ? [t('agent_studio.card.only_you', 'Only you')] : []),
        ...(countPart ? [countPart] : []),
        ...usageParts(t, footer),
    ];

    // Nothing to say is saying nothing: an empty line under the card would only take up space and suggest that something is missing.
    if (parts.length === 0) return null;

    return (
        <span
            className="block text-xs text-[var(--text-tertiary)]"
            data-testid="agent-card-footer"
            data-variant={footer.variant}
        >
            {parts.map((part, i) => (
                <React.Fragment key={`${i}-${part}`}>
                    {i > 0 && <span aria-hidden="true"> · </span>}
                    <span className={unreadable && part === countPart ? 'italic' : undefined}>{part}</span>
                </React.Fragment>
            ))}
        </span>
    );
}
