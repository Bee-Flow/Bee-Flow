// @vitest-environment node
/**
 * The KB-store overlay is gone, and stays gone.
 *
 * KBMarketplace.jsx and KBDetailPage.jsx were mounted from exactly one place —
 * AgentHub's ternary, behind the `showKBStore` flag. The only thing that could
 * ever set that flag to true was the `onOpenKBStore` prop handed to Sidebar,
 * and Sidebar only ever DESTRUCTURED it: no call site, anywhere. So two full
 * screens sat in the bundle, wired to state, fetching KB categories and
 * favourites, and were unreachable for years without a single test, type error
 * or lint warning going red. A prop that is destructured but never called is
 * invisible to every tool we run — nothing is unused, nothing is undefined,
 * the code merely never executes. That is exactly how these two rode along.
 *
 * Knowledge bases now live in the Studio (KnowledgeStudio), which owns the
 * `kb-detail-page` testid the e2e suite drives. This test pins the removal so a
 * revert has to be deliberate rather than accidental: if someone re-adds the
 * mount, or re-adds the prop to Sidebar's signature without a caller, the
 * dead-screen shape is back and this goes red.
 *
 * Asserted over the source text (same approach as AgentHub.overlayOrder.test.js)
 * because rendering AgentHub means standing up the whole app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_HUB = fs.readFileSync(path.join(HERE, 'AgentHub.jsx'), 'utf8');
const SIDEBAR = fs.readFileSync(path.join(HERE, 'components/shell/Sidebar.jsx'), 'utf8');

describe('AgentHub — the unreachable KB-store overlay is removed', () => {
    it('no longer imports or mounts KBMarketplace', () => {
        expect(
            AGENT_HUB,
            'AgentHub.jsx names KBMarketplace again. That component was deleted; a '
            + 'reference to it either resurrects a screen nothing can open, or breaks '
            + 'the build outright.',
        ).not.toMatch(/KBMarketplace/);
    });

    it('no longer imports or mounts KBDetailPage', () => {
        expect(
            AGENT_HUB,
            'AgentHub.jsx names KBDetailPage again. KB detail lives in the Studio '
            + '(components/admin/Studio/KnowledgeStudio), which owns the '
            + '`kb-detail-page` testid — two components carrying that testid is how '
            + 'the e2e suite ends up driving the dead one.',
        ).not.toMatch(/KBDetailPage/);
    });

    it('has no showKBStore flag left anywhere in the file', () => {
        expect(
            AGENT_HUB,
            'showKBStore is back in AgentHub.jsx. It was a flag that nothing could '
            + 'ever set to true: state, an entry in closeAllOverlays and a branch of '
            + 'the render ternary, all for a screen with no way in.',
        ).not.toMatch(/showKBStore/);
    });

    it('Sidebar no longer destructures the onOpenKBStore prop', () => {
        expect(
            SIDEBAR,
            'Sidebar.jsx destructures onOpenKBStore again. Check it is actually '
            + 'CALLED somewhere — a destructured-but-never-called prop is the exact '
            + 'shape that left the KB store dead and silent for years.',
        ).not.toMatch(/onOpenKBStore/);
    });
});
