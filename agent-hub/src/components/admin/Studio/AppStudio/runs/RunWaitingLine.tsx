import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import { approvalWaitLine } from '../runtime/approvalWaitLine';
import type { RunWaiting } from './runsApi';

const NS = 'studio_apps_h2.runs';

/**
 * The line of a run on hold in the run log: an approval and who decides it (with the moment the
 * request closes), or the moment a wait ends.
 */
export default function RunWaitingLine({ waiting }: { waiting: RunWaiting | undefined }) {
    const { t, locale } = useTranslation();
    if (!waiting) return null;
    const at = waiting.wakeAt ? new Date(waiting.wakeAt) : null;
    const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' }) : null;
    let text: string;
    if (waiting.kind === 'approval') {
        const who = approvalWaitLine(waiting.waitingFor ?? undefined, t) ?? t(`${NS}.approval`, 'Waiting for an approval');
        text = when ? t(`${NS}.approval_closes`, '{who}; the request closes {time}', { who, time: when }) : who;
    } else {
        text = when ? t(`${NS}.until`, 'Waiting until {time}', { time: when }) : t(`${NS}.open`, 'Waiting to be continued');
    }
    return <p className="text-[var(--text-secondary)]" data-testid="run-detail-waiting">{text}</p>;
}
