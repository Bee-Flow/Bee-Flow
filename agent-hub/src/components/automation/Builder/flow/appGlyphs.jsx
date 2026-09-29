import { Boxes, Briefcase, Code2, Grid2x2, HeartPulse, LayoutGrid, Puzzle, Share2, Sparkles, Workflow } from 'lucide-react';
import IntegrationLogo from './nodes/IntegrationLogo';
import { getIntegrationLogo } from '../../../../utils/integrationLogos';

/**
 * The glyphs the ribbon's Apps tab prints on its commands.
 *
 * An app's mark is <IntegrationLogo> — the same resolution every surface
 * uses (icon-pack override, the app's own glyph for a vendor whose apps share
 * one brand mark, the brand SVG, the letter mark; see utils/integrationGlyphs
 * and nodes/IntegrationLogo). What the ribbon adds is a fallback for an app
 * with no mark at all (a platform tool, an MCP server): a plain piece, so
 * that, like every command on the Home tab, it still has an icon in front of
 * its name. And a glyph per CATEGORY, for a whole category folded into one
 * pill when the row is too narrow (flow/appsRibbonLayout.js).
 */

export function AppGlyph({ integrationId, size = 14 }) {
    return (
        <IntegrationLogo
            integrationId={integrationId}
            size={size}
            fallback={<Puzzle size={size} className="text-[var(--text-tertiary)]" aria-hidden="true" />}
        />
    );
}

// Vendors get their mark or colour; the kinds get the lucide that says what
// they are.
const CATEGORY_GLYPH = {
    'Google Workspace': { Icon: LayoutGrid, color: '#4285F4' },
    'Microsoft 365': { Icon: Grid2x2, color: '#0078D4' },
    'AI & Media': { Icon: Sparkles },
    Developer: { Icon: Code2 },
    Automation: { Icon: Workflow },
    Productivity: { Icon: Briefcase },
    Health: { Icon: HeartPulse },
    Social: { Icon: Share2 },
};

export function categoryGlyphFor(category, size = 14) {
    // The VENDOR's mark, straight from the brand map: through IntegrationLogo
    // the id `nextcloud` would resolve to the Files app's own folder glyph.
    if (category === 'Nextcloud') {
        const Rings = getIntegrationLogo('nextcloud');
        if (Rings) return <Rings size={size} />;
    }
    const { Icon, color } = CATEGORY_GLYPH[category] || { Icon: Boxes };
    return <Icon size={size} style={color ? { color } : undefined} aria-hidden="true" />;
}
