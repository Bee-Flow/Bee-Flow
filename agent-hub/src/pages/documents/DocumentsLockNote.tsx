import { Lock } from 'lucide-react';
import React from 'react';
import { documentsLockText } from './documentsLock';

/**
 * The one line the Documents pages show while `studio_documents` is locked:
 * making and changing is closed, opening, downloading and archiving are not.
 * Renders nothing when there is no lock reason.
 */
export default function DocumentsLockNote({
    reason, d, className = '', iconSize = 13,
}: {
    reason: string | null;
    d: (en: string, nl?: string) => string;
    className?: string;
    iconSize?: number;
}) {
    if (!reason) return null;
    return (
        <p data-testid="documents-locked" className={`flex items-start gap-2 text-[var(--text-muted)] ${className}`}>
            <Lock size={iconSize} className="mt-px shrink-0" aria-hidden />
            <span>{documentsLockText(reason, d)}</span>
        </p>
    );
}
