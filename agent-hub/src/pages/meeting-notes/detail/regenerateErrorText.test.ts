import { describe, expect, it } from 'vitest';
import { regenerateErrorText } from './useMeetingCommands';
import type { TranslateFn } from '@/hooks/useTranslation';

const t = ((_key: string, fallback: string, params: Record<string, string> = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => params[name] ?? `{${name}}`)) as unknown as TranslateFn;

const coded = (status: number, code: string, message = 'server text') => Object.assign(new Error(message), { status, code });

describe('regenerateErrorText', () => {
    it('an empty model answer says nothing was changed', () => {
        expect(regenerateErrorText(t, coded(502, 'summary_empty'))).toMatch(/no summary, so nothing was changed/);
    });

    it('a re-transcription that runs or ran says to regenerate again afterwards', () => {
        expect(regenerateErrorText(t, coded(409, 'already_processing'))).toMatch(/re-transcribed.*regenerate again/);
        expect(regenerateErrorText(t, coded(409, 'transcript_changed'))).toMatch(/re-transcribed.*regenerate again/);
    });

    it('anything else keeps the generic sentence with the message', () => {
        expect(regenerateErrorText(t, new Error('boom'))).toBe('Regenerate failed: boom');
    });
});
