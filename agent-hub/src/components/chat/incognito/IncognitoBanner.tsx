/**
 * What an incognito chat says about itself for as long as it is on: that it
 * is incognito, what that means, and what it does NOT switch off. The last
 * line matters as much as the first: the organisation's compliance logs (the
 * knowledge base query log) and the usage counts still apply, and a privacy
 * claim that leaves that out promises more than the product keeps.
 */
import { Ghost } from 'lucide-react';
import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';

export default function IncognitoBanner() {
    const { t } = useTranslation();
    return (
        <div
            role="note"
            data-testid="incognito-banner"
            className="mx-auto mb-2 flex w-full max-w-[760px] items-start gap-2.5 rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-secondary)] px-3.5 py-2.5"
        >
            <Ghost className="mt-0.5 h-4 w-4 shrink-0 text-[var(--text-primary)]" aria-hidden="true" />
            <div className="min-w-0 text-xs leading-relaxed text-[var(--text-secondary)]">
                <p className="font-semibold text-[var(--text-primary)]">{t('incognito.banner_title', 'Incognito chat')}</p>
                <p>{t('incognito.banner_body', 'Not saved, no memory, and it ends when you leave this chat.')}</p>
                <p className="text-[var(--text-tertiary)]">
                    {t('incognito.banner_compliance', "Your organisation's compliance logs (such as the knowledge base query log) and usage counts still apply.")}
                </p>
            </div>
        </div>
    );
}
