import { createContext, useContext } from 'react';

export type CoworkMode = 'orb' | 'chat' | 'advanced';
export const DisplayMode = createContext<CoworkMode>('orb');
export const useCoworkMode = () => useContext(DisplayMode);

const visitModes = new Map<string, CoworkMode>();
export function rememberMode(key: string, value: CoworkMode) {
    try { localStorage.setItem(key, value); }
    catch { visitModes.set(key, value); }
}

export function savedMode(key: string): CoworkMode | null {
    const fallback = visitModes.get(key);
    if (fallback) return fallback;
    try {
        const value = localStorage.getItem(key);
        return value === 'orb' || value === 'chat' || value === 'advanced' ? value : null;
    } catch { return null; }
}
