import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';

/**
 * useHeaderPrimary: hands a register's ONE create action ("Plan audit",
 * "Record nonconformity", "Add obligation") to the section header, through
 * the hub's `setHeaderActions({ primaryAction })` (registerSpecs'
 * actionPrimary draws it), while the register is on screen, and takes it
 * back when the register goes.
 *
 * Returns whether the header carries the action. A host without
 * `setHeaderActions` draws no Compliance header, so the register keeps the
 * button in its own toolbar: the action is never lost, only moved.
 *
 * The click handler is read through a ref, so a host may pass an inline
 * function: re-registering on every render would re-render the hub, which
 * re-renders the page, which registers again.
 */
export interface HeaderPrimaryAction {
    label: string;
    icon?: LucideIcon;
    onClick: () => void;
    disabled?: boolean;
}

export type SetHeaderActions = ((actions: Record<string, unknown>) => void) | null | undefined;

export default function useHeaderPrimary(setHeaderActions: SetHeaderActions, action: HeaderPrimaryAction): boolean {
    const { label, icon, disabled = false, onClick } = action;
    const onClickRef = useRef(onClick);
    useEffect(() => { onClickRef.current = onClick; });
    useEffect(() => {
        if (typeof setHeaderActions !== 'function') return undefined;
        setHeaderActions({ primaryAction: { label, icon, disabled, onClick: () => onClickRef.current() } });
        return () => setHeaderActions({});
    }, [setHeaderActions, label, icon, disabled]);
    return typeof setHeaderActions === 'function';
}
