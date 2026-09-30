/**
 * Pinned to the web and the server: the Azure panel's constants and model
 * rules run beside agent-hub's own (differential); the n8n slug, workflow
 * defaults and search, the Nextcloud countdown, freshness and occ commands,
 * and GitHub's name and branch grammar are pinned to their sources (textual).
 */

import fs from 'node:fs';
import path from 'node:path';

import { AGENT_HUB_SRC, loadWebModule } from '@/shared/testing/webModule';

import { AZURE_SECTIONS, AZURE_TIERS, isClaudeReasoning, isReasoningCapable, PANEL_TIER_LABELS, SYNC_INTERVALS, TIER_DEFAULTS } from './azure';
import { BRANCH_RE, REPO_NAME_RE } from './github';
import { FRESH_MS } from './nextcloud';

const SERVER = path.resolve(__dirname, '../../../../../server');
const readWeb = (rel: string) => fs.readFileSync(`${AGENT_HUB_SRC}/${rel}`, 'utf8');
const readServer = (rel: string) => fs.readFileSync(path.join(SERVER, rel), 'utf8');

interface WebAzure {
    SUB_SECTIONS: { id: string; labelKey: string; descKey: string; color: string }[];
    TIERS: { key: string; icon: string; labelKey: string; descKey: string }[];
    TIER_DEFAULTS: Record<string, { maxTokens: number; temperature: number }>;
    isReasoningCapable: (id: string | null) => boolean;
    isClaudeReasoning: (id: string | null) => boolean;
}

describe('Azure lockstep', () => {
    const web = loadWebModule<WebAzure>('components/integrations/azure/constants.js', { Cloud: 'Cloud', Shield: 'Shield', Layers: 'Layers', FileText: 'FileText' });

    it('lists the web’s sections and tiers, with its keys and defaults', () => {
        expect(AZURE_SECTIONS.map(({ id, labelKey, descKey, color }) => ({ id, labelKey, descKey, color }))).toEqual(
            web.SUB_SECTIONS.map(({ id, labelKey, descKey, color }) => ({ id, labelKey, descKey, color })),
        );
        expect(AZURE_TIERS.map(({ key, icon, labelKey, descKey }) => ({ key, icon, labelKey, descKey }))).toEqual(web.TIERS);
        expect(TIER_DEFAULTS).toEqual(web.TIER_DEFAULTS);
    });

    it('asks the web’s question about reasoning models', () => {
        for (const id of [null, '', 'o3', 'o4-mini', 'gpt-5-mini', 'gpt-4.1', 'claude-opus-4-8', 'claude-3-haiku', 'mistral-large-latest']) {
            expect({ id, r: isReasoningCapable(id), c: isClaudeReasoning(id) }).toEqual({ id, r: web.isReasoningCapable(id), c: web.isClaudeReasoning(id) });
        }
    });

    it('names empty tiers as the server does, and offers the web’s sync intervals', () => {
        const server = readServer('routes/orgAzureConfig.js');
        const labels = Object.entries(PANEL_TIER_LABELS).map(([k, v]) => `${k}: '${v}'`).join(', ');
        expect(server).toContain(`const PANEL_TIERS = { ${labels} };`);
        const sso = readWeb('components/integrations/azure/SSOSection.jsx');
        const offered = [...sso.matchAll(/<option value=\{(\d+)\}>/g)].map((m) => Number(m[1]));
        expect(offered).toEqual([...SYNC_INTERVALS]);
    });
});

describe('n8n lockstep (pages/settings/N8nSection.jsx)', () => {
    const src = readWeb('pages/settings/N8nSection.jsx');

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
    it('counts down, calls a sync fresh and writes the occ commands as the web does', () => {
        const pairing = readWeb('components/integrations/nextcloud/OrgNcPairingPanel.jsx');
        expect(pairing).toContain("`${min}m ${sec.toString().padStart(2, '0')}s remaining`");
        expect(pairing).toContain('occ app_api:app:setenv bee_flow BEEFLOW_PAIRING_CODE <CODE>\nocc app_api:app:disable bee_flow\nocc app_api:app:enable bee_flow');
        const sync = readWeb('components/integrations/nextcloud/NextcloudSyncPanel.jsx');
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
