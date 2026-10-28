import { Clock, ClipboardList, FilePlus, Mail, MousePointer2, Webhook } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { TONE_CLASSES, TRIGGER_TONES, toneLabelOf, triggerGlyphKeyOf, triggerToneOf } from './triggerTone';
import { TRIGGER_ICONS } from '@/components/automation/Builder/flow/triggerIcons';
import type { AutomationRecord } from './overviewModel';

const triggerGlyphOf = (a: AutomationRecord) => TRIGGER_ICONS[triggerGlyphKeyOf(a)];
import { readAppCss } from '@/test/appStylesheets';

const appEvent = (provider: string, event: string) => ({ id: 'a', triggerType: 'app_event', definition: { trigger: { kind: 'app_event', appEvent: { provider, event } } } });

describe('triggerToneOf', () => {
    it('reads the plain kinds', () => {
        expect(triggerToneOf({ id: 'a', triggerType: 'schedule' })).toBe('schedule');
        expect(triggerToneOf({ id: 'a', triggerType: 'manual' })).toBe('manual');
        expect(triggerToneOf({ id: 'a', triggerType: 'form' })).toBe('form');
        expect(triggerToneOf({ id: 'a' })).toBe('manual');
    });

    it('falls back on the definition when the column is empty', () => {
        expect(triggerToneOf({ id: 'a', definition: { trigger: { kind: 'schedule' } } })).toBe('schedule');
    });

    it('splits app events by provider: Nextcloud, mail, other apps', () => {
        expect(triggerToneOf(appEvent('nextcloud', 'file.tagged'))).toBe('nextcloud');
        expect(triggerToneOf(appEvent('gmail', 'label.added'))).toBe('mail');
        expect(triggerToneOf(appEvent('msgraph', 'mail.new'))).toBe('mail');
        expect(triggerToneOf(appEvent('msgraph', 'event.created'))).toBe('app');
        expect(triggerToneOf(appEvent('github', 'issue.opened'))).toBe('app');
    });

    it('groups webhooks, Studio App buttons and agent calls as app; the rest is other', () => {
        for (const k of ['webhook', 'app_trigger', 'agent_call']) expect(triggerToneOf({ id: 'a', triggerType: k })).toBe('app');
        expect(triggerToneOf({ id: 'a', triggerType: 'layer_input' })).toBe('other');
        expect(triggerToneOf({ id: 'a', triggerType: 'from_the_future' })).toBe('other');
    });
});

describe('triggerGlyphOf', () => {
    it('uses the canvas trigger glyphs', () => {
        expect(triggerGlyphOf({ id: 'a', triggerType: 'schedule' })).toBe(Clock);
        expect(triggerGlyphOf({ id: 'a', triggerType: 'manual' })).toBe(MousePointer2);
        expect(triggerGlyphOf({ id: 'a', triggerType: 'webhook' })).toBe(Webhook);
        expect(triggerGlyphOf({ id: 'a', triggerType: 'form' })).toBe(ClipboardList);
        expect(triggerGlyphOf(appEvent('nextcloud', 'file.new'))).toBe(FilePlus);
        expect(triggerGlyphOf(appEvent('msgraph', 'mail.new'))).toBe(Mail);
    });
});

describe('tone classes and labels', () => {
    const css = readAppCss();
    it('every tone has a tile, a text and an accent class and an English label', () => {
        for (const tone of TRIGGER_TONES) {
            expect(TONE_CLASSES[tone].tile).toMatch(/text-\[var\(--/);
            expect(TONE_CLASSES[tone].accent).toMatch(/^bg-\[var\(--/);
            expect(toneLabelOf(tone, null)).toBeTruthy();
        }
    });

    it('every variable the classes name is declared in the stylesheets, the new --trigger-* in both sets', () => {
        const vars = new Set(Object.values(TONE_CLASSES).flatMap(c => [...`${c.tile} ${c.text} ${c.accent}`.matchAll(/var\((--[a-z-]+)\)/g)].map(m => m[1])));
        for (const v of vars) expect(css, v).toMatch(new RegExp(`${v}\\s*:`));
        for (const v of ['--trigger-schedule', '--trigger-manual', '--trigger-mail', '--trigger-nextcloud', '--trigger-form']) {
            expect((css.match(new RegExp(`${v}\\s*:`, 'g')) || []).length, `${v} needs a dark and a light value`).toBe(2);
        }
    });
});
