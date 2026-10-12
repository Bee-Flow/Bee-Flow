import { Link2, Loader2 } from 'lucide-react';
import React from 'react';
import {
    cannotComeAlong, comingAlong, type RelatedPart, type RelatedState,
} from './relatedParts';
import { partLabel, whyNot, whyText } from './relatedText';
import { SECTIONS } from './solutionSections';
import Notice from './Notice';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * "Comes along": under the checklist, what else the ticked parts need and
 * whether it can be filed with them.
 *
 * Two groups, because they ask different things of the reader. What CAN come
 * along is information (it is filed with the selection, dependencies first).
 * What CANNOT is a warning: the part is needed but sits in another Solution,
 * belongs to someone else or no longer exists, and the release check will flag
 * it as missing from this Solution. The read itself has three states told
 * apart: asking, could not ask (adding still works, without the related
 * parts) and answered.
 */

const KIND_ICON = new Map(SECTIONS.map(s => [s.kind, s.icon]));

function PartRow({ part, line, testId }: { part: RelatedPart; line: string; testId: string }) {
    const { t } = useTranslation();
    const Icon = KIND_ICON.get(part.kind) ?? Link2;
    return (
        <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 rounded-[var(--radius-md)] text-sm bg-[var(--bg-card)] border border-[var(--border-subtle)]" data-testid={testId}>
            <Icon className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <span className="flex-1 min-w-[8rem] truncate text-[var(--text-primary)]">{partLabel(t, part)}</span>
            <span className="text-[11px] text-[var(--text-tertiary)]">{line}</span>
        </li>
    );
}

export default function RelatedPartsNotice({ state, onRetry }: { state: RelatedState; onRetry: () => void }) {
    const { t } = useTranslation();
    if (state.status === 'idle') return null;

    if (state.status === 'loading') {
        return (
            <Notice tone="info" icon={Loader2} testId="related-loading">
                {t('solutions.related_loading', 'Checking what else these need…')}
            </Notice>
        );
    }

    if (state.status === 'error') {
        return (
            <Notice
                tone="warning"
                testId="related-error"
                action={<button type="button" onClick={onRetry} data-testid="related-retry" className="underline min-h-[32px] rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">{t('solutions.add_retry', 'Try again')}</button>}
            >
                {t('solutions.related_error', 'Could not check what else these need. You can still add them, but nothing related will come along.')}
            </Notice>
        );
    }

    const along = comingAlong(state);
    const blocked = cannotComeAlong(state);
    const here = state.result.related.filter(p => p.status === 'already_here');
    if (along.length === 0 && blocked.length === 0 && here.length === 0) return null;

    return (
        <div className="space-y-2" data-testid="related-notice">
            {along.length > 0 && (
                <Notice tone="info" icon={Link2} testId="related-along">
                    <p className="font-medium">{t('solutions.related_title', 'Comes along')}</p>
                    <p className="text-[12px] text-[var(--text-secondary)] mb-2">{t('solutions.related_intro', 'These are needed by what you ticked, so they are added with it.')}</p>
                    <ul className="space-y-1">
                        {along.map(p => <PartRow key={`${p.kind}:${p.id}`} part={p} line={whyText(t, p)} testId="related-part" />)}
                    </ul>
                </Notice>
            )}
            {blocked.length > 0 && (
                <Notice tone="warning" testId="related-blocked">
                    <p className="font-medium">{t('solutions.related_blocked_title', 'These cannot come along')}</p>
                    <p className="text-[12px] text-[var(--text-secondary)] mb-2">{t('solutions.related_blocked_intro', 'They are needed but cannot be added here. The release check will flag them as missing from this Solution.')}</p>
                    <ul className="space-y-1">
                        {blocked.map(p => (
                            <PartRow key={`${p.kind}:${p.id}`} part={p} line={`${whyNot(t, p)} · ${whyText(t, p)}`} testId="related-blocked-part" />
                        ))}
                    </ul>
                </Notice>
            )}
            {here.length > 0 && (
                <p className="text-[11px] text-[var(--text-tertiary)]" data-testid="related-here">
                    {t('solutions.related_here', 'Already in this Solution: {names}', { names: here.map(p => partLabel(t, p)).join(', ') })}
                </p>
            )}
            {state.result.truncated && (
                <p className="text-[11px] text-[var(--warning-ink)]" data-testid="related-truncated">
                    {t('solutions.related_truncated', 'This pulls in a very large set of parts. Only the first {count} are listed.', { count: state.result.related.length })}
                </p>
            )}
        </div>
    );
}
