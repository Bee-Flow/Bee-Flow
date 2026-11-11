import { describe, expect, it } from 'vitest';
import { portabilityNote } from './portabilityNote';

type T = Parameters<typeof portabilityNote>[0];
const t = ((_key: string, en: string, params?: Record<string, unknown>) => en.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name]))) as unknown as T;

describe('portabilityNote', () => {
    it('says nothing for a report without a summary, so an older file reads as before', () => {
        expect(portabilityNote(t, undefined)).toBe('');
        expect(portabilityNote(t, null)).toBe('');
        expect(portabilityNote(t, {})).toBe('');
    });

    it('names the files that came along and the ones that did not', () => {
        expect(portabilityNote(t, { assets: { carried: 3, left: 1 } })).toBe(
            '3 uploaded files (pictures, logo, fonts) came along. 1 uploaded files did not come along; upload them again in the app.',
        );
    });

    it('says triggers arrive switched off, and webhooks get a new address and secret at publish', () => {
        const note = portabilityNote(t, { triggers: { count: 2, webhooks: 1, armed: false } });
        expect(note).toContain('2 triggers came along switched off');
        expect(note).toContain('new address and secret');
        expect(portabilityNote(t, { triggers: { count: 1, webhooks: 0, armed: false } })).not.toContain('webhook');
    });

    it('names column rights for a role the app lacks', () => {
        expect(portabilityNote(t, { columnRights: { unknownRoles: ['Table "x" field "y" names the role "ghost"'] } })).toContain('a role the app does not have');
    });
});
