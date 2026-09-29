import { Ban, Eye, OctagonAlert, ShieldCheck, UserCheck, Users } from 'lucide-react';
import { Fragment } from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { OUTCOME_TEXT } from '../shieldPalette';
import { isGuardDown, type GuardStatus, type OverviewFields } from './types';

/**
 * "What your people see" — the org-wide choices that every member meets in a
 * chat, rendered as that chat: the action (placeholders or stopped), the
 * reveal panel ("Show what was sent") and, when it is on, the last check.
 *
 * A preview, not an illustration: every line follows the form as edited,
 * unsaved edits included. Flip the action and the sentence changes; switch
 * the reveal panel off and its line disappears.
 *
 * The sample is fictional and hard-coded on purpose — it must never be a real
 * message from this organisation, on a screen whose whole subject is that
 * real messages are not shown to people who should not see them.
 */

/** The fictional sentence, split so each placeholder can be drawn as one. */
const SAMPLE: ReadonlyArray<{ text: string } | { token: string }> = [
    { text: 'Send the policy to ' },
    { token: '[email_1]' },
    { text: ' for ' },
    { token: '[name_1]' },
    { text: ', IBAN ' },
    { token: '[iban_1]' },
    { text: '.' },
];

/** How many details the sample replaces — counted, so the heading cannot drift from the sentence. */
const SAMPLE_TOKENS = SAMPLE.filter(part => 'token' in part).length;

/** Placeholders read in the "replaced" outcome colour, as on What happened. */
function Placeholder({ children }: { children: string }) {
    return (
        <span className={`px-[5px] py-px rounded bg-[color-mix(in_srgb,var(--type-loop)_14%,transparent)] ${OUTCOME_TEXT.replaced} font-semibold text-xs whitespace-nowrap`}>
            {children}
        </span>
    );
}

function ChatPreview({ tokenising, transparency, t }: { tokenising: boolean; transparency: boolean; t: TranslateFn }) {
    return (
        <div className="rounded-[10px] bg-[var(--bg-secondary)] p-3 flex flex-col gap-2">
            {tokenising ? (
                <p className="m-0 flex items-center gap-1.5 flex-wrap text-[11px]">
                    <ShieldCheck className="w-3 h-3 text-[var(--success-ink)]" aria-hidden="true" />
                    <b className="font-semibold text-[var(--success-ink)]">
                        {t('shield_overview.preview_replaced', '{n} details replaced', { n: SAMPLE_TOKENS })}
                    </b>
                    <span className="text-[var(--text-tertiary)]">{t('shield_overview.preview_replaced_tail', 'before this went to the AI')}</span>
                </p>
            ) : (
                <p className="m-0 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--error-ink)]">
                    <Ban className="w-3 h-3" aria-hidden="true" />
                    {t('privacy.action_blocked', 'Blocked')}
                </p>
            )}
            <p className="m-0 px-3 py-2.5 rounded-[10px] bg-[var(--bg-card)] text-[13px] leading-[22px] text-[var(--text-primary)]">
                {tokenising
                    ? SAMPLE.map((part, i) => ('token' in part
                        ? <Placeholder key={i}>{part.token}</Placeholder>
                        : <Fragment key={i}>{part.text}</Fragment>))
                    : t('admin.shield_preview_blocked_body',
                        'The message never reaches the AI. The person is told it contained personal data and is asked to rewrite it.')}
            </p>
            {/* The reveal panel's audience, stated where the choice shows. */}
            {transparency && (
                <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-[var(--text-tertiary)]">
                    <span className="inline-flex items-center gap-[5px]">
                        <Eye className="w-[11px] h-[11px]" aria-hidden="true" />
                        {t('shield_overview.preview_reveal', 'Click to reveal')}
                    </span>
                    <span className="text-[var(--warning-ink)]">{t('shield_overview.preview_audience', 'anyone in this conversation')}</span>
                </div>
            )}
        </div>
    );
}

/** The last check as the person meets it — only while it is on. Off is a review item now. */
function LastCheckPreview({ mode, t }: { mode: string; t: TranslateFn }) {
    let body: string;
    if (mode === 'auto_redact') body = t('admin.shield_preview_dlp_redact', 'Nobody is interrupted — findings are hidden and the message goes.');
    else if (mode === 'block') body = t('admin.shield_preview_dlp_block', 'The message is stopped before it reaches a model outside your organisation.');
    else body = t('admin.shield_preview_dlp_ask', 'On a model outside your organisation, the person is shown what was found and chooses.');
    return (
        <div className="rounded-[10px] border border-[var(--border-subtle)] px-3 py-2.5 flex flex-col gap-1.5">
            <p className="m-0 flex items-center gap-1.5 text-[11px] font-semibold text-[var(--text-primary)]">
                <UserCheck className="w-3 h-3" aria-hidden="true" />
                {t('dlp.review_title', 'Check this before it goes to the AI')}
            </p>
            <p className="m-0 text-[11px] leading-4 text-[var(--text-secondary)]">{body}</p>
            {mode === 'ask' && (
                <div className="flex gap-1.5 flex-wrap pt-0.5">
                    {[t('dlp.action_block', 'Block'), t('dlp.action_allow', 'Send anyway'), t('dlp.action_redact', 'Redact and send')].map(label => (
                        <span key={label} className="text-[10px] font-semibold px-2 py-0.5 rounded-md border border-[var(--border-default)] text-[var(--text-secondary)]">
                            {label}
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}

interface Props {
    f: Pick<OverviewFields, 'piiAction' | 'showRawPayload' | 'dlpEnabled' | 'dlpMode'>;
    guard: GuardStatus | null;
    t: TranslateFn;
}

export default function WhatPeopleSee({ f, guard, t }: Props) {
    const tokenising = f.piiAction === 'tokenize';
    const transparency = tokenising && !!f.showRawPayload;
    const dlpMode = f.dlpEnabled ? (f.dlpMode || 'ask') : null;
    return (
        <section
            aria-labelledby="org-shield-people-see"
            className="rounded-xl bg-[var(--bg-card)] border border-[var(--border-default)] shadow-[var(--shadow-sm)] px-4 py-3.5 flex flex-col gap-2.5"
        >
            <div className="flex items-center gap-2">
                <Users className="w-[15px] h-[15px] text-[var(--text-secondary)]" aria-hidden="true" />
                <h4 id="org-shield-people-see" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('admin.shield_preview_title', 'What your people see')}
                </h4>
            </div>
            <p className="m-0 text-xs leading-[18px] text-[var(--text-secondary)]">
                {t('shield_overview.preview_desc', 'How a chat looks with your current settings.')}
            </p>
            <ChatPreview tokenising={tokenising} transparency={transparency} t={t} />
            {dlpMode && <LastCheckPreview mode={dlpMode} t={t} />}
            {/* The claim rule, at the one moment it is load-bearing: while the
                scanner is down the chat must NOT say "protected". */}
            {isGuardDown(guard) && (
                <div className="flex gap-2 items-start pt-2 border-t border-[var(--border-subtle)]">
                    <OctagonAlert className="w-3.5 h-3.5 shrink-0 mt-px text-[var(--error-ink)]" aria-hidden="true" />
                    <p className="m-0 text-[11px] leading-4 text-[var(--text-secondary)]">
                        {t('admin.shield_preview_guard_down',
                            'While the detection service is down the chat says the protection is temporarily unavailable and the message is not sent. It never says “protected”.')}
                    </p>
                </div>
            )}
        </section>
    );
}
