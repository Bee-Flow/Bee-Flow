/**
 * Pinned to the web and the server: the Azure screens' sections, tiers and
 * sync schedule to the server's save schema and to the web group-sync card
 * (the web's own Azure form is gone; the phone keeps these screens and the
 * server keeps their writes); the n8n slug, workflow defaults and search, the
 * Nextcloud countdown, freshness and occ commands, and GitHub's name and
 * branch grammar are pinned to their sources (textual).
 */

import fs from 'node:fs';
import path from 'node:path';

import { webSourceText } from '@/shared/testing/webModule';

import { AZURE_SECTIONS, AZURE_TIERS, PANEL_TIER_LABELS, SYNC_INTERVALS } from './azure';
import { BRANCH_RE, REPO_NAME_RE } from './github';
import { FRESH_MS, pairingCommands, SETUP_PAGE_ADDRESSES } from './nextcloud';

const SERVER = path.resolve(__dirname, '../../../../../server');
const readWeb = (rel: string) => webSourceText(rel);
const readServer = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

describe('Azure lockstep', () => {
    const schema = readServer('routes/orgAzureConfigSchemas.mts');

    it('saves each screen under a section the server accepts', () => {
        const accepted = [...schema.matchAll(/section\('([A-Za-z]+)', \{/g)].map((m) => m[1]);
        for (const { id } of AZURE_SECTIONS) expect(accepted).toContain(id);
    });

    it('names empty tiers as the server does, for the tiers the screens show', () => {
        const labels = Object.entries(PANEL_TIER_LABELS).map(([k, v]) => `${k}: '${v}'`).join(', ');
        expect(schema).toContain(`const PANEL_TIERS: Record<string, string> = { ${labels} };`);
        expect(AZURE_TIERS.map(({ key }) => key)).toEqual(Object.keys(PANEL_TIER_LABELS));
    });

    it('offers the web group sync card\'s intervals, within the server\'s bounds', () => {
        const card = readWeb('components/integrations/azure/GroupSyncSection.tsx');
        const offered = [...card.matchAll(/<option value=\{(\d+)\}>/g)].map((m) => Number(m[1]));
        expect(offered).toEqual([...SYNC_INTERVALS]);
        expect(schema).toContain('.int(INTERVAL_TEXT).min(1, INTERVAL_TEXT).max(168, INTERVAL_TEXT)');
        expect(Math.min(...SYNC_INTERVALS)).toBeGreaterThanOrEqual(1);
        expect(Math.max(...SYNC_INTERVALS)).toBeLessThanOrEqual(168);
    });
});

describe('n8n lockstep (pages/settings/n8n/)', () => {
    // N8nSection is split: the slug, defaults and search live in n8nModel.ts,
    // the slug field's own filter in N8nWorkflowEditor.tsx.
    const src = [
        readWeb('pages/settings/n8n/n8nModel.ts'),
        readWeb('pages/settings/n8n/N8nWorkflowEditor.tsx'),
    ].join('\n');

    it('slugs, configures and searches as addWorkflow and the filters do', () => {
        expect(src).toContain(".toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').substring(0, 50)");
        expect(src).toContain("httpMethod: wfNode?.method || 'POST'");
        expect(src).toContain('description: `Run n8n workflow: ${discovered.name}`');
        expect(src).toContain("outputs: [{ name: 'result', type: 'string', description: 'Workflow output' }]");
        expect(src).toContain(".replace(/[^a-z0-9_]/g, '')");
        expect(src).toContain("(w.description || '').toLowerCase().includes(q)");
    });
});

describe('Nextcloud lockstep (components/integrations/nextcloud/*)', () => {
    it('counts down, calls a sync fresh and writes the install command as the web does', () => {
        const pairing = readWeb('components/integrations/nextcloud/OrgNcPairingPanel.tsx');
        expect(pairing).toContain("`${min}m ${sec.toString().padStart(2, '0')}s`");
        expect(pairing).toContain(`const AT_INSTALL_COMMAND = '${pairingCommands('<CODE>')}';`);
        expect(pairing).toContain(`const SETUP_PAGE_ADDRESSES = \`${SETUP_PAGE_ADDRESSES}\`;`);
        // AppAPI has no command that changes a value of an installed app.
        expect(pairing).not.toContain(['app_api:app:', 'setenv'].join(''));
        const sync = readWeb('components/integrations/nextcloud/NextcloudSyncPanel.tsx');
        expect(sync).toContain('< 30 * 60_000');
        expect(FRESH_MS).toBe(30 * 60_000);
        expect(sync).toContain("config.ncBaseUrl.replace(/^https?:\\/\\//, '')");
    });
});

describe('GitHub sync lockstep (server/routes/integrations/githubSync.js)', () => {
    it('checks names and branches with the server’s own grammar', () => {
        const server = readServer('routes/integrations/githubSync.js');
        expect(server).toContain(`const NAME_RE = ${REPO_NAME_RE.toString()};`);
        expect(server).toContain(`const BRANCH_RE = ${BRANCH_RE.toString()};`);
    });
});
