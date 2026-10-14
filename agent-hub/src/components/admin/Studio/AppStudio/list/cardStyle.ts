import type { CSSProperties } from 'react';

/**
 * The visual vocabulary every card in the Apps gallery shares: the owner/shared
 * app cards, the template cards in the New-app modal and the import preview.
 */

// Default accent matches APP_COLOR_PRESETS[0] in runtime/themeVars.js (teal).
const DEFAULT_ACCENT = '#0F766E';

// `${hex}1a` = ~10% alpha soft tint, same trick as the webpages gallery.
function accentTile(accentColor?: string | null): CSSProperties {
    const accent = /^#[0-9a-fA-F]{6}$/.test(accentColor || '') ? accentColor as string : DEFAULT_ACCENT;
    return { background: `${accent}1a`, color: accent };
}

const CARD_CLASSES = 'group relative rounded-xl border p-3.5 transition-all hover:shadow-md text-left';
const CARD_STYLE: CSSProperties = { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' };

export { accentTile, CARD_CLASSES, CARD_STYLE };
