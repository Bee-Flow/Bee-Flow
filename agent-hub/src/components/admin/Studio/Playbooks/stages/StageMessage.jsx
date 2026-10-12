import { AlertTriangle, Loader2 } from 'lucide-react';
import React from 'react';
import { TONES } from '../../../../shared/statusTone';

/**
 * One sentence, where a stage has nothing else to show.
 *
 * There were five of these across the wrappers — the automation phase waiting for
 * its PATCH, the app phase with no app, a load error, a load in flight, the
 * access phase with no app — and every one was a bare centred line of text: no
 * card, no tile, no `pbk-stage-enter`, no `role`, and two of them painted the
 * raw `--warning` token as words, which measures 3.3:1 on a light card.
 *
 * `tone`:
 *   busy    a spinner and the stage's own ink — the phase is doing something
 *   warn    something is missing and the person has to act
 *   error   it went wrong
 */
const TONE = {
    busy: { ink: 'var(--text-secondary)', Icon: Loader2, role: 'status', spin: true },
    warn: { ink: TONES.warning.ink, Icon: AlertTriangle, role: 'status', spin: false },
    error: { ink: TONES.error.ink, Icon: AlertTriangle, role: 'alert', spin: false },
};

export default function StageMessage({ tone = 'busy', presenter = false, testId = null, action = null, children }) {
    const { ink, Icon, role, spin } = TONE[tone] || TONE.busy;
    return (
        <div
            className="pbk-stage-enter h-full flex items-center justify-center"
            style={{ padding: presenter ? '32px' : '24px' }}
            data-testid={testId || undefined}
            data-tone={tone}
        >
            <div
                className="rounded-2xl flex items-start gap-3"
                style={{
                    maxWidth: 520,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-default)',
                    boxShadow: 'var(--shadow-md)',
                    padding: presenter ? 24 : 18,
                }}
            >
                <Icon
                    className={`shrink-0 ${spin ? 'animate-spin motion-reduce:animate-none' : ''}`}
                    style={{ width: presenter ? 22 : 18, height: presenter ? 22 : 18, color: ink, marginTop: 1 }}
                    aria-hidden="true"
                />
                <div className="min-w-0">
                    <p role={role} style={{ fontSize: presenter ? 16 : 13, color: ink }}>{children}</p>
                    {action && <div className="mt-2.5">{action}</div>}
                </div>
            </div>
        </div>
    );
}
