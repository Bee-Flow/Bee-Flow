/**
 * Promise-based confirmation: `if (await confirm({...})) remove()`.
 *
 * Replaces Alert.alert, which renders in the OS palette, reads as a system
 * error next to the themed app and cannot say what is about to be lost. The
 * dialog is the kit's ConfirmSheet; ConfirmProvider (mounted once, in
 * app/_layout.tsx) owns the one sheet and every useConfirm() call shares it.
 */

import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { ConfirmSheet } from '@/shared/ui';

export interface ConfirmOptions {
    title: string;
    /** What happens, and what is lost. The sheet has room for a sentence. */
    message: string;
    confirmLabel: string;
    /** `destructive` (default) paints the button red; `primary` for a safe action. */
    tone?: 'destructive' | 'primary';
}

/** Resolves true on confirm, false on cancel, back, or a newer request. */
export type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
    // The options outlive `visible` so the sheet keeps its text while it
    // slides away instead of blanking mid-animation.
    const [options, setOptions] = useState<ConfirmOptions | null>(null);
    const [visible, setVisible] = useState(false);
    const pending = useRef<((ok: boolean) => void) | null>(null);

    const settle = useCallback((ok: boolean) => {
        const resolve = pending.current;
        pending.current = null;
        setVisible(false);
        resolve?.(ok);
    }, []);

    const confirm = useCallback<ConfirmFn>(
        (next) =>
            new Promise<boolean>((resolve) => {
                // One sheet at a time: a newer request answers the older "no".
                pending.current?.(false);
                pending.current = resolve;
                setOptions(next);
                setVisible(true);
            }),
        [],
    );

    // A caller awaiting across an unmount must not hang forever.
    useEffect(() => () => pending.current?.(false), []);

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            {options ? (
                <ConfirmSheet
                    visible={visible}
                    title={options.title}
                    message={options.message}
                    confirmLabel={options.confirmLabel}
                    tone={options.tone}
                    onConfirm={() => settle(true)}
                    onCancel={() => settle(false)}
                />
            ) : null}
        </ConfirmContext.Provider>
    );
}

/** The confirm function. Throws outside ConfirmProvider, like useTheme. */
export function useConfirm(): ConfirmFn {
    const confirm = useContext(ConfirmContext);
    if (!confirm) throw new Error('useConfirm must be used inside <ConfirmProvider>');
    return confirm;
}
