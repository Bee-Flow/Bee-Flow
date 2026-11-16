import { describe, expect, it } from 'vitest';
import { shortModelName } from './modelNames';

describe('shortModelName', () => {
    it('strips every provider path, one level or more', () => {
        expect(shortModelName('anthropic/claude-sonnet-5')).toBe('claude-sonnet-5');
        expect(shortModelName('azure/my-deployment')).toBe('my-deployment');
        expect(shortModelName('scaleway/mistral/mistral-small-3.2-24b')).toBe('mistral-small-3.2-24b');
        expect(shortModelName('ionos/meta-llama/Llama-3.3-70B-Instruct')).toBe('Llama-3.3-70B-Instruct');
        expect(shortModelName('ollama/llama3:8b')).toBe('llama3:8b');
    });

    it('drops a dated snapshot and keeps a bare id as it is', () => {
        expect(shortModelName('openai/gpt-x-2025-01-31')).toBe('gpt-x');
        expect(shortModelName('eugpt-auto')).toBe('eugpt-auto');
    });

    it('names a missing model with the fallback', () => {
        expect(shortModelName(null)).toBe('Unknown');
        expect(shortModelName('  ', 'Onbekend')).toBe('Onbekend');
    });

    it('keeps the id when stripping would leave nothing', () => {
        expect(shortModelName('provider/')).toBe('provider/');
    });
});
