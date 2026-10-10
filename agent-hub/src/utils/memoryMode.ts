import scopedStorage from './scopedStorage';

/**
 * What this chat does with memory:
 *   on   — read what is remembered and save new things
 *   read — read, but save nothing from this chat
 *   off  — neither read nor write (for this browser's chats until changed)
 */
export type MemoryMode = 'on' | 'read' | 'off';

export const MEMORY_MODES: readonly MemoryMode[] = ['on', 'read', 'off'];

const MODE_KEY = 'memoryMode';
/** The key of the old two-state switch. Still read, and still written for older code. */
const LEGACY_WRITE_KEY = 'memoryWriteEnabled';

/** Where the person has to go to change a state the composer cannot change. */
export type MemoryLock = 'user_paused' | 'org_off' | null;

export interface MemoryFlags {
    memoryReadEnabled: boolean;
    memoryWriteEnabled: boolean;
}

export function isMemoryMode(v: unknown): v is MemoryMode {
    return v === 'on' || v === 'read' || v === 'off';
}

/** The stored mode; an old boolean `false` means Read only, as it always did. */
export function readStoredMemoryMode(): MemoryMode {
    const mode = scopedStorage.getItem(MODE_KEY);
    if (isMemoryMode(mode)) return mode;
    return scopedStorage.getItem(LEGACY_WRITE_KEY) === 'false' ? 'read' : 'on';
}

export function storeMemoryMode(mode: MemoryMode): void {
    scopedStorage.setItem(MODE_KEY, mode);
    scopedStorage.setItem(LEGACY_WRITE_KEY, String(mode === 'on'));
}

export function nextMemoryMode(mode: MemoryMode): MemoryMode {
    return MEMORY_MODES[(MEMORY_MODES.indexOf(mode) + 1) % MEMORY_MODES.length];
}

export function memoryFlagsFor(mode: MemoryMode): MemoryFlags {
    return { memoryReadEnabled: mode !== 'off', memoryWriteEnabled: mode === 'on' };
}

/** The two request flags for the stored mode. */
export function readStoredMemoryFlags(): MemoryFlags {
    return memoryFlagsFor(readStoredMemoryMode());
}

/** Why the composer cannot change memory, if it cannot. The org wins over the person. */
export function memoryLockOf(user: { memoryEnabled?: boolean; orgMemoryEnabled?: boolean } | null | undefined): MemoryLock {
    if (user?.orgMemoryEnabled === false) return 'org_off';
    if (user?.memoryEnabled === false) return 'user_paused';
    return null;
}

/** Window event that asks the app shell to open the memory panel. */
export const OPEN_MEMORY_PANEL_EVENT = 'beeflow:open-memory-panel';

export function openMemoryPanel(): void {
    window.dispatchEvent(new CustomEvent(OPEN_MEMORY_PANEL_EVENT));
}
