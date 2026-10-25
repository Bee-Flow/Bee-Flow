import { RUN_STATE } from '../testSetFacts';
import { nOf } from '../../../../admin/Studio/KnowledgeStudio/plural';
import type { AboutLineProps } from '../TestSetCard.types';

export function AboutLine({ t, summary, justRan = null }: AboutLineProps) {
    if (justRan && !justRan.kept) return null;
    if (summary.state !== RUN_STATE.RESULT) return null;
    const parts = [];
    if (summary.source === 'published' && summary.version) {
        parts.push(t('agent_studio.test.about_version', 'about v{version}', { version: summary.version }));
        if (summary.unpublishedChanges !== null && summary.unpublishedChanges > 0) {
            parts.push(nOf(t, 'agent_studio.test.about_ahead', summary.unpublishedChanges,
                '{count} unpublished change since', '{count} unpublished changes since'));
        }
    } else if (summary.source === 'live') {
        parts.push(t('agent_studio.test.about_draft', 'about your draft'));
    }
    if (summary.coverage && summary.coverage.of !== null && summary.coverage.ran !== summary.coverage.of) {
        // Two sentences, because there are two different facts: how many questions stand NOW
        // (the normal case), and how many stood THEN, when the run ran (if the current list
        // could not be read).
        parts.push(summary.coverage.when === 'then'
            ? nOf(t, 'agent_studio.test.covers_then', summary.coverage.of,
                'covers {ran} of the {count} question this agent had then',
                'covers {ran} of the {count} questions this agent had then',
                { ran: summary.coverage.ran })
            : nOf(t, 'agent_studio.test.covers', summary.coverage.of,
                'covers {ran} of the {count} question you have now',
                'covers {ran} of the {count} questions you have now',
                { ran: summary.coverage.ran }));
    }
    const stale = summary.stale.changed
        ? t('agent_studio.test.stale_changed', 'A question changed after this run, so the score is about the older wording.')
        : summary.stale.added
            ? t('agent_studio.test.stale_added', 'A question was added after this run.')
            : summary.stale.removed
                ? t('agent_studio.test.stale_removed', 'This run covered a question that no longer exists.')
                : null;
    if (parts.length === 0 && !stale) return null;
    return (
        <div data-testid="agent-tests-about" className="text-[12px] text-[var(--text-tertiary)]">
            {parts.join(' · ')}
            {stale && <span className="block text-[var(--warning)]">{stale}</span>}
        </div>
    );
}
