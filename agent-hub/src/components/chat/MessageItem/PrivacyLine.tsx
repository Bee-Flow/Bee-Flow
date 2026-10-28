import React from 'react';
import { Lock } from 'lucide-react';
import { interpolate } from '@/hooks/useTranslation';
import { describePrivacyLine } from './privacyLine';

type PrivacyLineT = (key: string, en: string, params?: Record<string, unknown>) => string;

interface PrivacyLineProps {
    count?: number;
    messageText?: string;
    tokenMap?: unknown;
    scanIncomplete?: boolean;
    t?: PrivacyLineT;
}

/** Reserve-`t` die wél interpoleert — zie de koptekst. */
const FALLBACK_T = (_key: string, en: string, params?: Record<string, unknown>) => interpolate(en, params);

/**
 * The privacy line under a message (C7).
 *
 * Two forms, and the difference between them is the entire finding. See `privacyLine.js` for the measurement
 * beneath it. What matters here:
 *
 *   • The demonstration form names the placeholder that was actually put in its place. It appears only if that is known.
 *   • The unproven form says that the screen cannot show the placeholder. It does NOT say "the real value stayed
 *     here". That is precisely the sentence that is not checked without a token map, and a privacy claim without a
 *     measurement beneath it is worse than no claim.
 *
 * The line replaced the blue "N items redacted" pill under the user message. That pill was the counter form: a claim
 * about a number, without a single hint with it. The amber "Scan incomplete" pill stands apart from it and remains.
 *
 * ── Two things that this sentence does NOT do ──────────────────────────────
 * 1. CLAIM MEMBERSHIP. Where more has been replaced than has been shown, there is no "{count} replaced, including
 *    {tokens}": that would make the shown placeholder a member of a collection that the screen does not know (the
 *    token vault is conversation-wide). The two claims therefore stand next to each other: the server counted this
 *    many, AND this token stands for a value in this message.
 * 2. REASSURE ABOUT A PASS-THROUGH. If a part of this turn was not checked, that part went UNREDACTED to the AI under
 *    fail_open. "the real value stayed here" is then true about what was shown and misleading about the rest, so the
 *    sentence gets the pass-through directly after it, in the sentence itself and not only in the pill beside it.
 *    PrivacyPanel already does this (`anyIncompleteAttachment`). The rule that became the primary, always visible
 *    claim may not have lost that condition.
 *
 * The fallback `t` MUST interpolate: the sentences carry a `{count}`, and a fallback that only returns its second
 * argument puts that placeholder literally on screen when a caller passes no `t`.
 */
export default function PrivacyLine({
    count, messageText, tokenMap, scanIncomplete = false, t = FALLBACK_T,
}: PrivacyLineProps) {
    const line = describePrivacyLine({ count, messageText, tokenMap, scanIncomplete });
    if (!line) return null;

    const sentence = line.form === 'unproven'
        ? t(
            line.count === 1 ? 'dlp.line_unproven' : 'dlp.line_unproven_plural',
            line.count === 1
                ? '1 value was replaced before this went to the AI — this screen cannot show which placeholder took its place'
                : '{count} values were replaced before this went to the AI — this screen cannot show which placeholders took their place',
            { count: line.count },
        )
        : line.partial
            ? t(
                'dlp.line_replaced_partial',
                // Two separate claims, deliberately not merged into one: the count comes from the server, the hint from this screen.
                '{count} values were replaced before this went to the AI. {tokens} stands for a value in this message — that real value stayed here',
                { count: line.count },
            )
            : t(
                line.count === 1 ? 'dlp.line_replaced' : 'dlp.line_replaced_plural',
                line.count === 1
                    ? '1 value replaced with {tokens} — the real value stayed here'
                    : '{count} values replaced with {tokens} — the real values stayed here',
                { count: line.count },
            );

    // `{tokens}` deliberately remains in the translated sentence: the placeholders are not text but monospace chips,
    // and those do not survive interpolate(). If the placeholder is missing from a translation, they end up at the back.
    // They never disappear, because then the count form would remain.
    const at = sentence.indexOf('{tokens}');
    const before = at === -1 ? sentence : sentence.slice(0, at);
    const after = at === -1 ? '' : sentence.slice(at + '{tokens}'.length);

    return (
        <span
            data-testid="privacy-line"
            data-privacy-line={line.form}
            className="text-[11px] leading-[16px] text-[var(--text-tertiary)]"
        >
            <Lock className="w-3 h-3 inline-block shrink-0 mr-1 align-[-2px]" aria-hidden="true" />
            {before}
            {line.tokens.map((token, i) => (
                <React.Fragment key={token}>
                    {i > 0 && ', '}
                    <code
                        data-testid="privacy-line-token"
                        className="font-mono rounded px-1 bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    >
                        {token}
                    </code>
                </React.Fragment>
            ))}
            {after}
            {line.incomplete && (
                <span data-testid="privacy-line-incomplete">
                    {' '}
                    {t(
                        'dlp.line_scan_incomplete',
                        'Part of this message could not be checked, and that part was sent as it was.',
                    )}
                </span>
            )}
        </span>
    );
}
