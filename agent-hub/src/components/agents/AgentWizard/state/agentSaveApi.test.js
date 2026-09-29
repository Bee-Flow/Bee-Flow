/**
 * `adoptedPromptAfterSave` — de ene regel die persona en prompt bij elkaar
 * houdt na een opslag (A3 deel B).
 *
 * Een persona in veldmodus IS de bron van `agents.system_prompt`: de server
 * rendert hem en negeert wat de client meestuurde. Neemt de editor dat antwoord
 * niet over, dan schrijft de eerstvolgende opslag zónder persona zijn oude
 * tekst er weer overheen — en beschrijft de kolom daarna een prompt dat de
 * agent niet meer draait.
 *
 * Run: cd agent-hub && ./node_modules/.bin/vitest run src/components/agents/AgentWizard/state/agentSaveApi.test.js
 */
import { describe, expect, it } from 'vitest';
import { adoptedPromptAfterSave } from './agentSaveApi';

const CASE = (over = {}) => ({
    sentPersona: { mode: 'fields', who: 'You are support.' },
    sentSystemPrompt: 'You are the invoice desk. Be brief.',
    localSystemPrompt: 'You are the invoice desk. Be brief.',
    savedSystemPrompt: 'You are support.\n\nWhat you do:\n- Answer questions',
    ...over,
});

describe('adoptedPromptAfterSave', () => {
    it('neemt de rendering van de server over na een opslag mét persona', () => {
        expect(adoptedPromptAfterSave(CASE())).toBe('You are support.\n\nWhat you do:\n- Answer questions');
    });

    it('doet niets als er geen persona meeging — dan rendert de server niets', () => {
        expect(adoptedPromptAfterSave(CASE({ sentPersona: undefined }))).toBeNull();
        expect(adoptedPromptAfterSave(CASE({ sentPersona: null }))).toBeNull();
    });

    it('laat toetsaanslagen van na de opslag ALTIJD winnen', () => {
        // Die tekst leeft alleen in stateRef; overschrijven is hem kwijtraken.
        expect(adoptedPromptAfterSave(CASE({ localSystemPrompt: 'ik typte intussen door' }))).toBeNull();
    });

    it('overschrijft niets op een antwoord dat geen prompt draagt', () => {
        for (const savedSystemPrompt of [undefined, null, 42, {}]) {
            expect(adoptedPromptAfterSave(CASE({ savedSystemPrompt }))).toBeNull();
        }
    });

    it('doet niets als het antwoord hetzelfde zegt als wat er al staat', () => {
        expect(adoptedPromptAfterSave(CASE({ savedSystemPrompt: 'You are the invoice desk. Be brief.' }))).toBeNull();
    });

    it('neemt ook een LEEG prompt over — dat is een antwoord, geen ontbrekende waarde', () => {
        expect(adoptedPromptAfterSave(CASE({ savedSystemPrompt: '' }))).toBe('');
    });
});
