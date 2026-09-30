import { passwordCheck } from './password';

describe('passwordCheck', () => {
    it('says nothing about empty fields and is not ready', () => {
        expect(passwordCheck('', '', '')).toEqual({ tooShort: false, mismatch: false, ready: false });
    });

    it('flags a short new password and a repeat that differs', () => {
        expect(passwordCheck('old', 'short', 'shorter')).toEqual({
            tooShort: true,
            mismatch: true,
            ready: false,
        });
    });

    it('is ready with the current password and a matching eight-character new one', () => {
        expect(passwordCheck('old', 'long enough', 'long enough').ready).toBe(true);
    });
});
