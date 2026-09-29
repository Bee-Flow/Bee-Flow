import { HelpCircle, Layers } from 'lucide-react';
import React from 'react';
import useTranslation from '../../hooks/useTranslation';

/**
 * "Used by" — what depends on this page.
 *
 * There is no endpoint that answers this for webpages yet (agents and
 * knowledge bases have one; webpages do not). So this tab does the one thing
 * a screen may do when it cannot answer: it SAYS it cannot, and reports only
 * the single relationship the loaded row really carries — the Solution the
 * page is filed into (`projectId`).
 *
 * It deliberately does NOT print "0" or "nothing uses this page". That is a
 * claim, and an owner who reads it might delete a page three routines link
 * to. The tab's badge in the header is absent for the same reason.
 */
export default function WebpageUsedByTab({ page }) {
    const { t } = useTranslation();
    const inSolution = !!page?.projectId;

    return (
        <div className="h-full overflow-auto custom-scrollbar px-6 py-6" style={{ background: 'var(--bg-primary)' }} data-testid="webpage-usedby">
            <div className="max-w-[560px] flex flex-col gap-3">
                {inSolution && (
                    <div
                        className="flex items-start gap-2.5 rounded-xl px-3.5 py-3"
                        data-testid="webpage-usedby-solution"
                        style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-card)' }}
                    >
                        <Layers size={15} className="mt-0.5 shrink-0" aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
                        <div className="text-[13px]" style={{ color: 'var(--text-primary)' }}>
                            {t('webpages.used_by.in_solution', 'This page is part of a Solution.')}
                        </div>
                    </div>
                )}
                <div
                    className="flex items-start gap-2.5 rounded-xl px-3.5 py-3"
                    style={{ border: '1px solid var(--border-subtle)', background: 'var(--bg-secondary)' }}
                >
                    <HelpCircle size={15} className="mt-0.5 shrink-0" aria-hidden="true" style={{ color: 'var(--text-tertiary)' }} />
                    <div className="text-[13px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                        {t('webpages.used_by.unknown',
                            'Bee Flow cannot list everything that links to this page yet, so treat this as incomplete rather than as "nothing uses it".')}
                    </div>
                </div>
            </div>
        </div>
    );
}
