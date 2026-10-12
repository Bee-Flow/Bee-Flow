import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { isTopicOp } from '../utils/conditionModel';

/**
 * The line under a condition that uses "is about": what the classifier reads,
 * that the text stays on this server, and, when the classifier is not
 * available, why the rule will not run yet. Nothing when no row (`ops`, the
 * rows' operator keys) asks "is about", or when the caller offers no topics.
 */

export interface TopicsCapability {
    available: boolean;
    reason?: string | null;
}

const REASONS: Record<string, [string, string]> = {
    not_configured: ['automations.builder.topics.reason_not_configured', 'No topic classifier is installed on this server. Ask an admin to start classify-service; until then this rule cannot run.'],
    unreachable: ['automations.builder.topics.reason_unreachable', 'The topic classifier is not answering right now. The rule is saved, but a run would stop here.'],
    loading: ['automations.builder.topics.reason_loading', 'The topic classifier is still starting. Try again in a minute.'],
    error: ['automations.builder.topics.reason_error', 'The topic classifier reported a problem. Ask an admin to check classify-service.'],
};

export default function TopicNotice({ topics, ops }: { topics?: TopicsCapability | null; ops: string[] }) {
    const { t } = useTranslation();
    if (!topics || !ops.some((op) => isTopicOp(op))) return null;
    const reason = topics && !topics.available ? REASONS[topics.reason || 'error'] || REASONS.error : null;
    return (
        <div className="space-y-0.5 text-[10px]">
            {reason && (
                <div className="text-amber-600 dark:text-amber-400">{t(reason[0], reason[1])}</div>
            )}
            <div className="text-[var(--text-tertiary)]">
                {t('automations.builder.topics.hint', 'A classifier on this server reads the start and the end of each text and decides. Nothing leaves the server. Name one thing per topic, like “a complaint”.')}
            </div>
            <div className="text-[var(--text-tertiary)]">
                {t('automations.builder.topics.hint_together', 'The topics in this node are judged together: adding one can shift the others a little, and an item that fits two topics may only go down one.')}
            </div>
        </div>
    );
}
