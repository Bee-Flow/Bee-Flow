// Small building blocks shared by the sections of the integrations admin
// panel: a status chip, a save button with its spinner, a "what it can do"
// list and a quiet note. Colours come from the theme tokens only.

import { Check, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { CHIP, CHIP_SUCCESS, HINT } from '@/components/mcpLibrary/ui';
import { SAVE_BUTTON } from '@/components/shared/SettingsList';

/** A small chip: green when `on`, neutral otherwise. */
export function StatusChip({ on = true, children }: { on?: boolean; children: ReactNode }) {
    return <span className={on ? CHIP_SUCCESS : CHIP}>{children}</span>;
}

interface SaveButtonProps {
    saving: boolean;
    disabled?: boolean;
    onClick: () => void;
    children: ReactNode;
    /** Shown instead of the check mark while not saving. */
    icon?: ReactNode;
    id?: string;
}

/** The primary action of a group: a spinner while it runs. */
export function SaveButton({ saving, disabled, onClick, children, icon, id }: SaveButtonProps) {
    return (
        <button type="button" id={id} onClick={onClick} disabled={saving || disabled} className={`${SAVE_BUTTON} shrink-0 gap-1.5`}>
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : (icon ?? <Check className="h-3.5 w-3.5" aria-hidden="true" />)}
            {children}
        </button>
    );
}

/** A plain list of what a provider does (the emoji leaders stay in the texts). */
export function Capabilities({ title, children }: { title: ReactNode; children: ReactNode }) {
    return (
        <div className="px-4 py-3">
            <h4 className="m-0 mb-1.5 text-[13px] font-medium text-[var(--text-primary)]">{title}</h4>
            <ul className="m-0 flex list-none flex-col gap-1 p-0 text-xs text-[var(--text-secondary)]">{children}</ul>
        </div>
    );
}

/** A one-line hint under a control, with room for a link. */
export function Hint({ children }: { children: ReactNode }) {
    return <p className={`m-0 ${HINT}`}>{children}</p>;
}

/** Link class for an external console or docs page inside a hint. */
export const HINT_LINK = 'underline hover:text-[var(--accent-primary)]';
