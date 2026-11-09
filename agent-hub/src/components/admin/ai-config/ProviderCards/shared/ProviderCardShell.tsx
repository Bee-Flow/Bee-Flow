import React from 'react';

/**
 * Shared bits of the provider panes: the input styling and the small status
 * pill. The card shell that used to live here is gone: a provider's header is
 * providers/PaneHeader.tsx and its body sits in a Section.
 */

// Shared input styling for the plain text inputs across provider cards.
export const PROVIDER_INPUT_CLS =
    'w-full px-4 py-2.5 rounded-lg border outline-none focus:border-[var(--accent-primary)] text-sm';
export const PROVIDER_INPUT_STYLE = {
    background: 'var(--bg-secondary)',
    borderColor: 'var(--border-default)',
    color: 'var(--text-primary)',
};

// Literal class strings (NOT interpolated) so Tailwind's scanner keeps them.
const TONE_CLS = {
    green: 'bg-green-500/20 text-green-400',
    blue: 'bg-blue-500/20 text-blue-400',
    orange: 'bg-orange-500/20 text-orange-400',
};

interface ProviderStatusPillProps {
    tone?: keyof typeof TONE_CLS;
    children?: React.ReactNode;
}

/** A small rounded status pill (Endpoint / Key / model badges). */
export const ProviderStatusPill = ({ tone = 'green', children }: ProviderStatusPillProps) => (
    <span className={`text-[10px] px-2 py-0.5 rounded-full ${TONE_CLS[tone] || TONE_CLS.green}`}>{children}</span>
);
