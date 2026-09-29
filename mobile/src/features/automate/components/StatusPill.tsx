/**
 * The one place a run status becomes a colour and a word.
 *
 * Every screen on this tab shows status somewhere, and the web app's history
 * is that each surface rolled its own green — which is how `awaiting_approval`
 * ended up rendering as a grey "queued" play icon for a year. Both components
 * here read the same table in format.ts, so a new server state changes one row
 * and appears everywhere at once.
 *
 * Both take an optional `step`: the whole recorded step row, which is what
 * lets the table tell a step that was switched off (grey) from one that ran
 * and found nothing to do (amber). Pass it wherever the row is at hand; with
 * only a status word a `skipped` step stays grey, because the word alone
 * carries no reason.
 */

import { Feather } from '@expo/vector-icons';
import React from 'react';

import { useTranslation } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge } from '../../../ui/Badge';
import { Spinner } from '../../../ui/Feedback';
import { statusLabel, statusToken, tokenForStep, type RunStepLike, type StatusTone } from '../format';
import type { RunStatus } from '../types';

export function StatusBadge({
    status,
    step = null,
}: {
    status?: RunStatus | null;
    step?: RunStepLike | null;
}) {
    const t = useTranslation();
    const token = step ? tokenForStep(step) : statusToken(status);
    return <Badge label={statusLabel(t, token)} tone={token.tone} />;
}

/**
 * The leading mark of a run row. A live run gets a real spinner rather than a
 * static clock: on a list of thirty finished runs, the one that is still going
 * has to be findable without reading a single word.
 */
export function StatusIcon({
    status,
    step = null,
    size = 18,
}: {
    status?: RunStatus | null;
    step?: RunStepLike | null;
    size?: number;
}) {
    const theme = useTheme();
    const token = step ? tokenForStep(step) : statusToken(status);

    if (token.live && token.icon === 'loader') {
        return <Spinner />;
    }

    const colour: Record<StatusTone, string> = {
        neutral: theme.colors.textMuted,
        accent: theme.colors.accentPrimary,
        // The builder's step-family blue, not the org's accent: a running run
        // has to look the same in every organisation.
        ai: theme.colors.typeAi,
        success: theme.colors.success,
        warning: theme.colors.warning,
        error: theme.colors.error,
    };

    return (
        <Feather
            name={token.icon}
            size={size}
            color={colour[token.tone]}
            // The badge or the row's own accessibilityLabel already says the
            // status in words; the glyph repeating it is noise in a screen
            // reader's ear.
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
        />
    );
}
