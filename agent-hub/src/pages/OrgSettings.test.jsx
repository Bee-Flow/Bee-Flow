import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

/**
 * OrgSettings — the "Knowledge Bases" tab after the Track Z cleanup.
 *
 * WHY THIS FILE EXISTS
 * The Track Z spec lists `KnowledgeBasesSection.jsx` under "Verwijderen", and
 * the handoff brief claimed it was already gone. It was not: it still sat on
 * disk AND was the live body of this page's `knowledge-bases` tab. Nothing in
 * the repo pinned that: there was no test on OrgSettings.jsx at all, so the
 * only thing standing between "delete the file" and a broken build was that
 * somebody happened to run `vite build`. A dangling relative import is not a
 * soft failure — Vite cannot resolve it, the production build dies, and in dev
 * the lazy OrgSettings chunk fails to load behind its Suspense boundary, i.e.
 * a white page for anyone with `manage_knowledge`.
 *
 * So the first test below is a static reference check, not a render: every
 * relative import in OrgSettings.jsx must resolve to a file that exists. It is
 * the cheapest possible stand-in for the bundler, it runs in milliseconds, and
 * it fails on exactly the mistake the spec invites — remove the component,
 * forget the importer.
 *
 * The second test pins the removal itself (the module must be gone, so the
 * duplicate admin CRUD cannot quietly come back), and the third pins that the
 * tab did not become empty in the process: an org's own knowledge bases are
 * created and ingested in Studio -> Knowledge now, and what remains here is
 * SystemKnowledgeBasesPanel. "The tab renders nothing" would be a silent
 * regression that a resolution check cannot see.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORG_SETTINGS = path.join(HERE, 'OrgSettings.tsx');
const REMOVED_SECTION = path.join(
    HERE, '..', 'components', 'agents', 'AgentDesigner', 'sections', 'KnowledgeBasesSection.jsx',
);

// Resolve a relative specifier the way the bundler does: exact file, then the
// extension ladder, then the directory's index.*.
const EXTS = ['', '.jsx', '.js', '.tsx', '.ts', '.json'];
function resolveSpecifier(fromFile, spec) {
    const base = path.resolve(path.dirname(fromFile), spec);
    for (const ext of EXTS) {
        const candidate = base + ext;
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
    for (const ext of EXTS.slice(1)) {
        const candidate = path.join(base, `index${ext}`);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function relativeImportsOf(file) {
    const src = fs.readFileSync(file, 'utf8');
    const specs = [];
    const re = /(?:^|\n)\s*import\s[^'"\n]*from\s*['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) specs.push(m[1]);
    // Dynamic imports (lazy chunks) break the build just as hard.
    const dyn = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    while ((m = dyn.exec(src)) !== null) specs.push(m[1]);
    return specs;
}

// Everything below the page is mocked at its module boundary; this suite is
// about OrgSettings' own tab wiring, not about the panels it hosts.
vi.mock('../components/agents/AgentDesigner/index', () => ({
    default: () => <div data-testid="mock-agent-designer" />,
}));
vi.mock('../components/admin/org/OrgUsersPanel', () => ({
    default: () => <div data-testid="mock-org-users" />,
}));
vi.mock('./settings/OrganisationSection', () => ({
    default: ({ activeSection }) => <div data-testid="mock-org-section" data-section={activeSection} />,
}));
vi.mock('../components/knowledge/SystemKnowledgeBasesPanel', () => ({
    default: () => <div data-testid="mock-system-kbs" />,
}));
vi.mock('../components/integrations/github/GitHubSyncPanel', () => ({
    default: () => <div data-testid="mock-github-sync" />,
}));
vi.mock('../components/integrations/nextcloud/NextcloudSyncPanel', () => ({
    default: () => <div data-testid="mock-nextcloud-sync" />,
}));

// Imported lazily INSIDE each render test on purpose. A dangling relative
// import in OrgSettings.jsx makes the module itself unloadable, and a
// top-level import would take the whole file down with it — including the
// static reference check that is supposed to NAME the broken specifier.
const loadOrgSettings = async () => (await import('./OrgSettings')).default;

const adminUser = { isAdmin: true, role: 'admin', permissions: ['all'] };

describe('OrgSettings — references', () => {
    it('every relative import resolves to a file that exists', () => {
        const specs = relativeImportsOf(ORG_SETTINGS);
        expect(specs.length).toBeGreaterThan(0);
        const dangling = specs.filter(s => resolveSpecifier(ORG_SETTINGS, s) === null);
        expect(dangling).toEqual([]);
    });

    it('no longer imports the removed KnowledgeBasesSection', () => {
        const src = fs.readFileSync(ORG_SETTINGS, 'utf8');
        expect(src).not.toMatch(/KnowledgeBasesSection\s*from/);
        expect(src).not.toMatch(/<KnowledgeBasesSection[\s/>]/);
    });

    it('the duplicate admin CRUD module is gone from disk', () => {
        expect(fs.existsSync(REMOVED_SECTION)).toBe(false);
    });
});

describe('OrgSettings — knowledge-bases tab', () => {
    it('still renders the system knowledge-bases panel', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={adminUser} orgSettingsPath={{ seg1: 'knowledge-bases' }} />);
        expect(screen.getByTestId('mock-system-kbs')).toBeTruthy();
    });

    it('does not render the removed org-KB manager', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={adminUser} orgSettingsPath={{ seg1: 'knowledge-bases' }} />);
        expect(screen.queryByTestId('kb-manager')).toBeNull();
    });

    it('keeps the tab reachable for a manage_knowledge-only user', async () => {
        // The tab is gated on `manage_knowledge` and nothing else; losing it
        // would move knowledge administration out of reach for the exact role
        // that needs it. (The tab is addressed explicitly here, so the test
        // does not depend on which tab such a user lands on by default.)
        const OrgSettings = await loadOrgSettings();
        const kbAdmin = { permissions: ['manage_knowledge'] };
        render(<OrgSettings user={kbAdmin} orgSettingsPath={{ seg1: 'knowledge-bases' }} />);
        expect(screen.getByTestId('mock-system-kbs')).toBeTruthy();
    });

    it('does not open the tab for a user without manage_knowledge', async () => {
        // Narrowing, not fail-open: an unknown/insufficient permission set must
        // fall back to a tab the user is allowed to see, never to the KB tab.
        const OrgSettings = await loadOrgSettings();
        const usersAdmin = { permissions: ['manage_users'] };
        render(<OrgSettings user={usersAdmin} orgSettingsPath={{ seg1: 'knowledge-bases' }} />);
        expect(screen.queryByTestId('mock-system-kbs')).toBeNull();
    });
});

describe('OrgSettings — organisation tab', () => {
    it('opens on the Organisation Info editor, not an empty page', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={adminUser} orgSettingsPath={{}} />);
        // OrganisationSection with 'info' is the editor plus its save bar; a
        // bare OrgInfoPanel without a section drew nothing.
        expect(screen.getByTestId('mock-org-section')).toHaveAttribute('data-section', 'info');
        expect(screen.getByRole('button', { name: 'Organisation' })).toHaveAttribute('aria-current', 'page');
    });

    it('is an org-admin tab: an agent editor lands on Agents instead of a form they cannot save', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={{ orgRole: 'agent_editor', permissions: ['manage_agents'] }} orgSettingsPath={{ seg1: 'organisation' }} />);
        expect(screen.queryByRole('button', { name: 'Organisation' })).toBeNull();
        expect(screen.queryByTestId('mock-org-section')).toBeNull();
        expect(screen.getByTestId('mock-agent-designer')).toBeTruthy();
    });

    it('stays open to an organisation admin without the global permission', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={{ orgRole: 'org_admin', permissions: ['org_admin', 'manage_users'] }} orgSettingsPath={{}} />);
        expect(screen.getByTestId('mock-org-section')).toHaveAttribute('data-section', 'info');
    });
});

describe('OrgSettings — tab bar', () => {
    it('names every tab through the dictionary, in the order of the page', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={adminUser} orgSettingsPath={{}} />);
        const bar = screen.getByRole('button', { name: 'Organisation' }).parentElement;
        expect(within(bar).getAllByRole('button').map(b => b.textContent)).toEqual([
            'Organisation', 'Agents', 'Knowledge Bases', 'GitHub Sync', 'Nextcloud Sync', 'Users',
        ]);
    });

    it('marks only the open tab as the current page', async () => {
        const OrgSettings = await loadOrgSettings();
        render(<OrgSettings user={adminUser} orgSettingsPath={{ seg1: 'users' }} />);
        expect(screen.getByRole('button', { name: 'Users' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'Organisation' })).not.toHaveAttribute('aria-current');
        expect(screen.getByTestId('mock-org-users')).toBeTruthy();
    });
});
