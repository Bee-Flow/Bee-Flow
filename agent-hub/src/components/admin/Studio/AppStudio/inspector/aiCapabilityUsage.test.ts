import { describe, it, expect } from 'vitest';
import { aiCapabilityUsage } from './aiCapabilityUsage';
import type { AppDefinition } from './appDefinition';

describe('aiCapabilityUsage', () => {
    it('counts distinct knowledge bases, web-search steps, browse steps and automations, nested too', () => {
        const def = {
            actions: {
                a1: { kind: 'sequence', steps: [
                    { kind: 'ai_generate', prompt: 'x', webSearch: true, knowledgeBaseIds: ['kb1', 'kb2'] },
                    { kind: 'condition', then: [{ kind: 'ai_extract', webSearch: true, knowledgeBaseIds: ['kb1'] }], else: [{ kind: 'ai_browse' }] },
                    { kind: 'run_automation', automationId: 'au1' },
                    { kind: 'run_automation', automationId: 'au1' },
                    { kind: 'kb_query', knowledgeBaseIds: ['kb3'] },
                    // webSearch on a kind that cannot search counts for nothing
                    { kind: 'send_email', webSearch: true },
                ] },
            },
        } as unknown as AppDefinition;
        expect(aiCapabilityUsage(def)).toEqual({ knowledgeBases: 3, webSearchSteps: 2, browseSteps: 1, automations: 1 });
    });

    it('an app without actions uses nothing', () => {
        expect(aiCapabilityUsage({})).toEqual({ knowledgeBases: 0, webSearchSteps: 0, browseSteps: 0, automations: 0 });
        expect(aiCapabilityUsage(null)).toEqual({ knowledgeBases: 0, webSearchSteps: 0, browseSteps: 0, automations: 0 });
    });
});
