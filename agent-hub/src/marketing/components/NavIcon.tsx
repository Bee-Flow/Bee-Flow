import IconGlyph from './IconGlyph';

/**
 * The mark beside a mega-menu / drawer item.
 *
 * Nav items used to store an emoji here (🐝, 🛡️, ⚖️). Emoji render in the
 * visitor's OS font, so the same menu is Apple's glossy set on a Mac, Segoe on
 * Windows and Noto on Android — three different visual languages, none of them
 * ours. So a nav icon is a Lucide name, matching how block icons work
 * elsewhere in the CMS, or an uploaded SVG/PNG of the site (IconGlyph).
 * Anything else is still rendered verbatim: sites seeded before this change
 * hold emoji in the same field. Back-compat, not a fallback for typos — an
 * unknown Lucide name renders nothing rather than the literal string, which is
 * AppIcon's behaviour and the right one here.
 */
export default function NavIcon({ icon, className = '' }: { icon?: string | null; className?: string }) {
    return <IconGlyph icon={icon} className={className} legacyText />;
}
