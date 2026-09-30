import fs from 'node:fs';
import path from 'node:path';

import { blankTier, deployedModels, nextSync, sectionStatus, temperatureFromText, TEMPERATURE_RANGE, tierFields, tiersBody, validEndpoint, validTenant } from './azure';
import type { AzureConfig, AzureTier } from './azureTypes';

const tier = (over: Partial<AzureTier>): AzureTier => ({ ...blankTier('fast'), ...over });

describe('Azure tiers', () => {
    it('saves the four panel tiers only, each over its untouched fields', () => {
        const body = tiersBody({
            fast: tier({ modelId: 'gpt-5-mini', maxTokens: 4000, raw: { modelId: 'old', label: 'Fast', topP: 0.9 } }),
            legacy: tier({ modelId: 'x' }),
        });
        expect(Object.keys(body)).toEqual(['fast', 'thinking', 'writer', 'pro']);
        expect(body.fast).toEqual({ modelId: 'gpt-5-mini', label: 'Fast', topP: 0.9, maxTokens: 4000 });
        expect(body.pro).toEqual({ modelId: '', label: 'Deep Thinking' });
    });

    it('sends the summary switch once it is on, or to switch a stored one off', () => {
        expect(tiersBody({ fast: tier({ reasoningSummary: true }) }).fast).toMatchObject({ reasoningSummary: true });
        expect(tiersBody({ fast: tier({ reasoningSummary: false, raw: { reasoningSummary: true } }) }).fast).toMatchObject({ reasoningSummary: false });
        expect(tiersBody({ fast: tier({}) }).fast).not.toHaveProperty('reasoningSummary');
    });

    it('shows a tier as text, with its defaults', () => {
        expect(tierFields('writer', tier({ maxTokens: null, temperature: 0.2 }))).toEqual({
            modelId: '',
            maxTokens: '',
            temperature: '0.2',
            defaults: { maxTokens: 16384, temperature: 0.7 },
        });
    });

    it('reads the deployed models from the comma list', () => {
        expect(deployedModels(' gpt-4.1, ,gpt-5-mini ')).toEqual(['gpt-4.1', 'gpt-5-mini']);
    });
});

describe('Azure checks and status', () => {
    it('accepts what the server accepts for tenant and endpoint', () => {
        expect(['', 'common', 'Organizations', '0c1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8'].every(validTenant)).toBe(true);
        expect(validTenant('contoso.onmicrosoft.com')).toBe(false);
        expect(['', 'https://x.openai.azure.com', 'http://localhost:1'].every(validEndpoint)).toBe(true);
        expect(validEndpoint('x.openai.azure.com')).toBe(false);
    });

    it('gives each section its hub chip', () => {
        const c = { azureEndpoint: 'https://x', hasAzureApiKey: false, chatModelTiers: { fast: tier({ modelId: 'a' }) }, ssoClientId: 'id', hasSsoClientSecret: true, hasAzureDocEndpoint: false, hasAzureDocKey: false } as unknown as AzureConfig;
        expect(sectionStatus('openai', c)).toBe('partial');
        expect(sectionStatus('chatModels', c)).toBe(1);
        expect(sectionStatus('sso', c)).toBe('configured');
        expect(sectionStatus('docProcessing', c)).toBeNull();
    });

    it('says when the periodic sync runs next', () => {
        const now = Date.parse('2026-09-25T12:00:00Z');
        expect(nextSync(null, 6, now)).toBeNull();
        expect(nextSync('2026-09-25T05:00:00Z', 6, now)).toEqual({ kind: 'overdue', text: '' });
        expect(nextSync('2026-09-25T06:00:30Z', 6, now)).toEqual({ kind: 'imminent', text: '' });
        expect(nextSync('2026-09-25T11:30:00Z', 1, now)).toEqual({ kind: 'in', text: '30m' });
        expect(nextSync('2026-09-25T11:30:00Z', 6, now)).toEqual({ kind: 'in', text: '5h 30m' });
        expect(nextSync('2026-09-25T12:00:00Z', 3, now)).toEqual({ kind: 'in', text: '3h' });
    });
});

describe('a typed temperature', () => {
    it.each([
        ['0,7', 0.7],
        ['0.7', 0.7],
        ['0,', 0],
        ['0.', 0],
        ['1,25', 1.25],
        ['5', 2],
        ['2,5', 2],
    ])('reads %j as %p, within the range', (text, value) => {
        expect(temperatureFromText(text)).toBe(value);
    });

    it('is the default when empty, and keeps the stored value while the text is not a number yet', () => {
        expect(temperatureFromText('')).toBeNull();
        expect(temperatureFromText('  ')).toBeNull();
        expect(temperatureFromText('-')).toBeUndefined();
        expect(temperatureFromText('0.7.1')).toBeUndefined();
    });

    it('is bounded as the web field is', () => {
        const web = fs.readFileSync(path.resolve(__dirname, '../../../../../agent-hub/src/components/integrations/azure/ChatModelsSection.jsx'), 'utf8');
        const field = web.slice(web.indexOf("updateTier(tier.key, 'temperature'"));
        expect(/min=\{(\d+)\} max=\{(\d+)\}/.exec(field)?.slice(1).map(Number)).toEqual([TEMPERATURE_RANGE.min, TEMPERATURE_RANGE.max]);
    });
});
