import { Lock } from 'lucide-react';
import React from 'react';
import { sharingLockText } from './webpageSharingLock';
import useTranslation from '../../hooks/useTranslation';

/**
 * The one line a sharing control shows while `webpage_sharing` is locked:
 * what is locked, and what still works. Rendered next to the controls that
 * add an audience, never instead of the ones that remove one.
 */
export default function WebpageSharingLockNote({ reason, className = '' }: { reason: string | null; className?: string }) {
    const { t } = useTranslation();
    if (!reason) return null;
    return (
        <p
            data-testid="webpage-sharing-locked"
            className={`flex items-start gap-1.5 text-[11px] text-[var(--text-tertiary)] ${className}`}
        >
            <Lock className="w-3 h-3 mt-0.5 shrink-0" aria-hidden />
            <span>{sharingLockText(reason, t)}</span>
        </p>
    );
}
