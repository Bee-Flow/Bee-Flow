/**
 * Everything the composer can do besides typing, as DATA.
 *
 * The row of loose icons this replaced had grown to eight glyphs;
 * ComposerToolsMenu renders these as named rows behind one "+", grouped by
 * what they act on (add / reach / mode).
 *
 * Each condition is applied here, next to the row it gates, rather than inside
 * the menu — so a row and the panel it hands off to can never disagree about
 * whether they exist. The FLAGS themselves come from the composer, which
 * derives them once for both these rows and the pills beside them. A falsy
 * entry is simply dropped by the menu, which is why the `flag && { … }` shape
 * is used instead of a filter afterwards.
 *
 * Two rows that used to be here are deliberately gone, and both for the same
 * reason: knowledge bases and Skills are PILLS now, and an open-state may have
 * exactly one owner. A row and a pill both flipping it is the "the picker will
 * not open" bug — one opens it, the other closes it inside the same click.
 */
import { Brain, Globe, LayoutGrid, Paperclip, Phone } from 'lucide-react';

import { nextMemoryMode } from '../../../utils/memoryMode';
import scopedStorage from '../../../utils/scopedStorage';
import { memoryHint } from '../memory/memoryModeCopy';

export function buildComposerTools({
    t,
    onAttachClick,
    canCreateMedia,
    mediaMenuOpen,
    setMediaMenuOpen,
    canPickApps,
    appsOpen,
    setAppsOpen,
    canWebSearch,
    webSearchEnabled,
    webSearchBlocked,
    webSearchUnavailable = null,
    setWebSearchEnabled,
    simpleMode,
    showTierSlider,
    memoryMode,
    changeMemoryMode,
    memoryLock = null,
    voiceReady,
    voiceMode,
    setVoiceMode,
}) {
    return [
        {
            id: 'attach', group: 'add', kind: 'action', icon: Paperclip,
            label: t('chat.composer.tools_attach', 'Add photos & files'),
            onSelect: onAttachClick,
        },
        canCreateMedia && {
            id: 'media', group: 'add', kind: 'panel', icon: '🎨',
            label: t('chat.composer.tools_media', 'Create image, music, video'),
            open: mediaMenuOpen, onOpenChange: setMediaMenuOpen,
        },
        // Knowledge bases are NOT a row here any more — they are a pill of
        // their own (C3), for the same reason Skills is: `showKBPicker` may
        // have exactly one owner. A row and a pill both flipping it is the
        // "the picker will not open" bug, one opening it and the other closing
        // it inside the same click.
        canPickApps && {
            id: 'apps', group: 'reach', kind: 'panel', icon: LayoutGrid,
            label: t('chat.composer.tools_apps', 'Apps'),
            hint: t('chat.composer.tools_apps_hint', 'What this chat may reach — Drive, Gmail, and the rest'),
            open: appsOpen, onOpenChange: setAppsOpen,
        },
        // Skills is NOT a row here any more — it is a pill of its own (C4), and
        // `skillsOpen` may only have one owner. A row and a pill both flipping
        // it is the "the picker will not open" bug: one opens it, the other
        // closes it in the same click.
        canWebSearch && {
            id: 'web-search', group: 'mode', kind: 'toggle', icon: Globe,
            label: t('chat.composer.tools_web_search', 'Web search'),
            on: webSearchEnabled && !webSearchBlocked && !webSearchUnavailable,
            dot: webSearchEnabled && !webSearchBlocked && !webSearchUnavailable,
            disabled: webSearchBlocked || !!webSearchUnavailable,
            // The server's reason wins: it is the one that actually refused.
            hint: webSearchUnavailable || t(
                webSearchBlocked ? 'chat.composer.tools_web_search_blocked' : 'chat.composer.tools_web_search_hint',
                webSearchBlocked
                    ? 'Web search disabled by organisation policy (files attached)'
                    : 'Let this turn look things up online',
            ),
            onSelect: () => {
                const next = !webSearchEnabled;
                setWebSearchEnabled(next);
                scopedStorage.setItem('webSearchEnabled', String(next));
            },
        },
        // In direct mode the memory switch rides in the tier slider's panel —
        // both answer "how much does the assistant bring to the next turn?".
        // This is the agent-chat fallback, where no slider is rendered.
        !simpleMode && !showTierSlider && {
            id: 'memory', group: 'mode', kind: 'toggle', icon: Brain,
            label: t('chat.composer.tools_memory', 'Memory'),
            on: memoryMode === 'on' && !memoryLock,
            dot: memoryMode !== 'on' || !!memoryLock,
            disabled: !!memoryLock,
            hint: memoryHint(t, memoryMode, memoryLock),
            onSelect: () => changeMemoryMode(nextMemoryMode(memoryMode)),
        },
        !simpleMode && voiceReady && {
            id: 'voice', group: 'mode', kind: 'toggle', icon: Phone,
            label: t('chat.composer.tools_voice', 'Voice mode'), beta: true,
            on: voiceMode,
            dot: voiceMode,
            hint: t('chat.composer.tools_voice_hint', 'Talk with your assistant instead of typing'),
            onSelect: () => setVoiceMode(!voiceMode),
        },
    ];
}
