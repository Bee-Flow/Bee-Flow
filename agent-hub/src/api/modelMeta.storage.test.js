/**
 * The `modelAliases` / `hiddenModels` device keys are legacy (no writer left
 * in src/): a corrupt value used to THROW straight out of JSON.parse and take
 * every model picker down with it. The reads are now guarded and shape-checked
 * — valid state behaves exactly as before (see modelMeta.local.test.js), junk
 * degrades to "no aliases / nothing hidden".
 *
 * Run: cd agent-hub && npx vitest run src/utils/modelMeta.storage.test.js
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { filterVisibleModels, getModelDisplayName } from './modelMeta';

const local = (id) => ({ id, name: id, local: true });

beforeEach(() => localStorage.clear());

describe('getModelDisplayName with hostile modelAliases', () => {
    it('does not throw on corrupt JSON and falls back to normal naming', () => {
        localStorage.setItem('modelAliases', '{not json at all');
        expect(() => getModelDisplayName('claude-sonnet-5')).not.toThrow();
        expect(getModelDisplayName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    });

    it('rejects a stored array — valid JSON is not an alias map', () => {
        localStorage.setItem('modelAliases', '["claude-sonnet-5"]');
        expect(getModelDisplayName('claude-sonnet-5')).toBe('Claude Sonnet 5');
    });

    it('a valid alias map still wins, exactly as before', () => {
        localStorage.setItem('modelAliases', JSON.stringify({ 'qwen3:8b': 'House model' }));
        expect(getModelDisplayName(local('qwen3:8b'))).toBe('House model');
    });
});

describe('filterVisibleModels with hostile hiddenModels', () => {
    it('does not throw on corrupt JSON and hides nothing', () => {
        localStorage.setItem('hiddenModels', '{oops');
        expect(() => filterVisibleModels([local('qwen3:8b')])).not.toThrow();
        expect(filterVisibleModels([local('qwen3:8b')]).map(m => m.id)).toEqual(['qwen3:8b']);
    });

    it('rejects a non-object shape and hides nothing', () => {
        localStorage.setItem('hiddenModels', '"qwen3:8b"');
        expect(filterVisibleModels([local('qwen3:8b')]).map(m => m.id)).toEqual(['qwen3:8b']);
    });
});
