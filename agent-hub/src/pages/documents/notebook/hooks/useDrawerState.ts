/**
 * useDrawerState — open/closed state for the workspace's left + right drawers,
 * persisted per surface variant in localStorage so the layout sticks across
 * reloads. Defaults: both open on first use.
 */
import { useState, useCallback } from 'react';
import { logger } from '../../../../utils/logger';

const key = (variant: string, k: string) => `bf.workspace.${variant}.${k}`;

function readBool(k: string, fallback: boolean) {
    try {
        const v = localStorage.getItem(k);
        return v == null ? fallback : v === '1';
    } catch { return fallback; }
}

function persist(k: string, v: boolean) {
    try { localStorage.setItem(k, v ? '1' : '0'); } catch (err) { logger.debug('ignore', err); }
}

interface DrawerDefaults {
    leftDefault?: boolean;
    rightDefault?: boolean;
}

export type DrawerUpdate = boolean | ((prev: boolean) => boolean);

export default function useDrawerState(variant = 'notebook', { leftDefault = true, rightDefault = true }: DrawerDefaults = {}) {
    const [leftOpen, setLeftState] = useState<boolean>(() => readBool(key(variant, 'leftOpen'), leftDefault));
    const [rightOpen, setRightState] = useState<boolean>(() => readBool(key(variant, 'rightOpen'), rightDefault));

    const setLeftOpen = useCallback((v: DrawerUpdate) => setLeftState((prev: boolean) => {
        const next = typeof v === 'function' ? v(prev) : v;
        persist(key(variant, 'leftOpen'), next);
        return next;
    }), [variant]);

    const setRightOpen = useCallback((v: DrawerUpdate) => setRightState((prev: boolean) => {
        const next = typeof v === 'function' ? v(prev) : v;
        persist(key(variant, 'rightOpen'), next);
        return next;
    }), [variant]);

    const toggleLeft = useCallback(() => setLeftOpen((p: boolean) => !p), [setLeftOpen]);
    const toggleRight = useCallback(() => setRightOpen((p: boolean) => !p), [setRightOpen]);

    return { leftOpen, rightOpen, setLeftOpen, setRightOpen, toggleLeft, toggleRight };
}
