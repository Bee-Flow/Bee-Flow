import type { TranslateFn } from '../../../hooks/useTranslation';
import type { MemoryLock, MemoryMode } from '../../../utils/memoryMode';

const STATE_EN: Record<MemoryMode, string> = { on: 'On', read: 'Read only', off: 'Off for this chat' };

const HINT_EN: Record<MemoryMode, string> = {
    on: 'Memory on: uses what is remembered and saves new things. Click for Read only.',
    read: 'Read only: uses what is remembered, saves nothing from this chat. Click to turn memory off for this chat.',
    off: 'Memory off for this chat: nothing is read or saved. Click to turn it on.',
};

const LOCK_EN: Record<Exclude<MemoryLock, null>, string> = {
    user_paused: 'Memory is paused. Resume it under Settings, Memory, to use it in chats.',
    org_off: 'Memory is switched off for your organisation. An admin can turn it on.',
};

export function memoryStateLabel(t: TranslateFn, mode: MemoryMode): string {
    return t(`chat.memory.state_${mode}`, STATE_EN[mode]);
}

/** The tooltip: what the state means and what a click does, or why the control is locked. */
export function memoryHint(t: TranslateFn, mode: MemoryMode, lock: MemoryLock): string {
    if (lock) return t(`chat.memory.lock_${lock}`, LOCK_EN[lock]);
    return t(`chat.memory.hint_${mode}`, HINT_EN[mode]);
}
