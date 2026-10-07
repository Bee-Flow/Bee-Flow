/**
 * The line under the box.
 *
 * Two different things sit on one row and only one of them is load-bearing.
 * The NOTICE (`warningText` from the call site, or the substantiated default
 * from composerClaims.footerNotice) says who is running this and what that
 * means for the text above it — a claim, and not optional. The Shift+Enter
 * reminder is a convenience, and it is the first thing to go in a drawer or on
 * a touch device, where there is no such shortcut to remind anyone of.
 *
 * Chat signals sit ABOVE that row as siblings, never inside it: the one-time
 * banner and the line that says what this organisation counts here, with the
 * person's own switch. They render only when the host passes a notice, and
 * the host passes one only for the endpoint the turn really goes to.
 */
import React from 'react';

import useTranslation from '../../../hooks/useTranslation';
import MonitoringBanner from '../chatSignals/MonitoringBanner';
import MonitoringNotice from '../chatSignals/MonitoringNotice';

const ComposerFooter = ({ compact, warningText, footerLine, isTouchDevice, chatSignalsNotice = null, onChatSignalsCounted = null }) => {
    const { t } = useTranslation();

    return (
        <div className={`text-center select-none ${compact ? 'mt-1' : 'mt-1.5 mb-0.5'}`}>
            {chatSignalsNotice && !compact && <MonitoringBanner notice={chatSignalsNotice} />}
            {chatSignalsNotice && (
                <MonitoringNotice notice={chatSignalsNotice} onCounted={onChatSignalsCounted} compact={compact} />
            )}
            <p
                data-testid="composer-footer"
                className={`text-[var(--text-tertiary)] ${compact ? 'text-[9px] leading-tight' : 'text-[10px]'}`}
            >
                {warningText || footerLine}
                {/* The keyboard hint is the first thing to go in a
                    drawer — the notice above it is not optional,
                    the shortcut reminder is. */}
                {!isTouchDevice && !compact && (
                    <>
                        <span className="mx-1.5">·</span>
                        <span>{t('chat.composer.shift_enter_hint', 'Shift+Enter for new line')}</span>
                    </>
                )}
            </p>
        </div>
    );
};

export default ComposerFooter;
