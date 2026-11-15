// The building blocks the Access screens share: the save status next to a
// heading, a titled group of capabilities in one bordered list, and the row of
// one capability (icon, name, a line under it, and a toggle or a lock).

import { AlertTriangle, Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { SettingsList } from '@/components/shared/SettingsList';
import { CHIP, EYEBROW } from '@/components/shared/adminUi';
import { availabilityReasonText } from '@/utils/integrationAvailability';
import type { AccessCapability, AccessKindSection } from './accessTypes';

/** "Saved" or the error of the last save, quiet and inline. */
export function AccessStatus({ message }: { message: { type: string; text: string } | null }) {
    if (!message) return null;
    const ok = message.type === 'ok';
    return (
        <span className={`inline-flex shrink-0 items-center gap-1.5 text-xs ${ok ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`}>
            {ok ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />}
            {message.text}
        </span>
    );
}

/** An eyebrow with the kind's icon and label (and a count), then its rows in one list. */
export function CapabilityGroup({ section, count, dimmed = false, children }: { section: AccessKindSection; count?: number; dimmed?: boolean; children: ReactNode }) {
    const { t } = useTranslation();
    const Icon = section.icon;
    return (
        <div className={`flex flex-col gap-2 ${dimmed ? 'opacity-60' : ''}`}>
            <p className={`${EYEBROW} flex items-center gap-1.5`}>
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {t(section.labelKey, section.label)}
                {count != null ? <span className="font-normal">({count})</span> : null}
            </p>
            <SettingsList>{children}</SettingsList>
        </div>
    );
}

interface CapabilityRowProps {
    cap: AccessCapability;
    icon: ReactNode;
    /** The line under the name; the description when left out. */
    note?: ReactNode;
    /** Right of the row: a toggle, a lock, or nothing. */
    trailing?: ReactNode;
    /** Clicking the row does what the toggle does; left out, the row is inert. */
    onActivate?: () => void;
    /** Outside the ceiling: drawn faded. */
    locked?: boolean;
    /** The server cannot serve this integration (no app, key or binding): a chip says so beside the name. */
    notSetUp?: boolean;
}

/** "Not set up on this server", beside a capability whose integration the server cannot serve yet. */
function NotSetUpChip() {
    const { t } = useTranslation();
    return <span className={`${CHIP} shrink-0`} data-testid="capability-not-set-up">{availabilityReasonText(t, 'not_configured')}</span>;
}

export function CapabilityRow({ cap, icon, note, trailing, onActivate, locked = false, notSetUp = false }: CapabilityRowProps) {
    return (
        <div
            data-capability={cap.id}
            onClick={onActivate}
            className={`flex items-center gap-3 px-4 py-2.5 ${onActivate ? 'cursor-pointer hover:bg-[var(--item-hover-bg)]' : ''} ${locked ? 'opacity-55' : ''}`}
        >
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--bg-secondary)] text-[var(--text-secondary)]" aria-hidden="true">{icon}</span>
            <div className="min-w-0 flex-1">
                <p className="m-0 flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                    <span className="truncate" title={cap.name}>{cap.name}</span>
                    {notSetUp ? <NotSetUpChip /> : null}
                </p>
                {note ?? (cap.description
                    ? <p className="m-0 truncate text-xs text-[var(--text-tertiary)]" title={cap.description}>{cap.description}</p>
                    : null)}
            </div>
            {trailing ? <span className="flex shrink-0 items-center" onClick={e => e.stopPropagation()}>{trailing}</span> : null}
        </div>
    );
}
