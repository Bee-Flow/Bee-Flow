import { describe, expect, it } from 'vitest';
import { isLargeInput } from './terminationsModel';

describe('isLargeInput', () => {
    it('flags a big max_tokens stop', () => {
        expect(isLargeInput({ termination_type: 'max_tokens', prompt_tokens: 9000, completion_tokens: 10 })).toBe(true);
    });
    it('does not flag a bad_request error row, however big its prompt', () => {
        expect(isLargeInput({ termination_type: 'error', error_code: 'bad_request', prompt_tokens: 50000 })).toBe(false);
    });
    it('flags an error row whose code says the input was too big', () => {
        expect(isLargeInput({ termination_type: 'error', error_code: 'payload_too_large', prompt_tokens: 50000 })).toBe(true);
        expect(isLargeInput({ termination_type: 'error', error_code: 'context_overflow', prompt_tokens: 50000 })).toBe(true);
    });
    it('hides token-based flags when showTokens is false', () => {
        expect(isLargeInput({ termination_type: 'max_tokens', prompt_tokens: 90000 }, false)).toBe(false);
    });
});
