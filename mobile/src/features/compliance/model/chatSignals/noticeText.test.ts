/**
 * The staff-notice text: the same literal keys and parameters as the web's
 * NoticeTemplate.tsx (textual lockstep), gaps as '[to fill in]', and the
 * start date formatted in UTC.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { TranslateFn } from '@/core/i18n';

import { formFromSettings, type StoredSettings } from './form';
import { formatNoticeDate, noticeText } from './noticeText';
import { previewActivity } from './ropaPreview';

const WEB = path.resolve(__dirname, '../../../../../../agent-hub/src/components/admin/compliance/pages/settings/chatMonitoring/NoticeTemplate.tsx');

/** Renders the fallback with its {params}, like the real dictionary would. */
const t: TranslateFn = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));

const OFF: StoredSettings = {
    enabled: false, surfaces: [], signals: [], effective_from: null, retention_days: 90, legal_basis: null, lia_at: null,
    works_council: null, works_council_reason: null, works_council_at: null,
    works_council_scope: { surfaces: [], signals: [], max_retention_days: null },
    dpia_ref: null, dpia_at: null, dpia_risk_level: null, dpo_advice_at: null, prior_consultation_at: null,
    notice_url: null, notice_published_at: null, enabled_at: null, enabled_by_name: null,
};
const NOW = new Date('2026-10-07T23:30:00.000Z');
const EMPTY_TEMPLATE = { dpoContact: null, dsrUrl: null, shieldLogRetentionDays: null };

const keysOf = (src: string) => [...src.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]);

describe('noticeText', () => {
    it('uses the web keys and parameters', () => {
        const web = fs.readFileSync(WEB, 'utf8');
        const webPart = web.slice(web.indexOf('function shieldLogRetention'), web.indexOf('export default function'));
        const port = fs.readFileSync(path.join(__dirname, 'noticeText.ts'), 'utf8');
        const portPart = port.slice(port.indexOf('function shieldLogRetention'));
        expect(keysOf(portPart)).toEqual(keysOf(webPart));
        const params = (s: string) => /\{\s*organisation:[\s\S]*?dpo_contact:[^\n]*/.exec(s)?.[0].replace(/\s+/g, ' ');
        expect(params(portPart)).toEqual(params(webPart));
    });

    it('leaves every unknown part as a gap', () => {
        const text = noticeText(t, { form: formFromSettings(OFF, NOW), template: EMPTY_TEMPLATE, orgName: null, startDay: '' }, 'en');
        expect(text.startsWith('Chat signals at [to fill in]')).toBe(true);
        expect(text).toContain('in [to fill in]. We count');
        expect(text).toContain('Why, and on which basis: [to fill in].\n');
        expect(text).toContain('Counting starts on [to fill in].');
        expect(text).toContain('It is kept for [to fill in]');
        expect(text).toContain('use [to fill in].');
        expect(text).toContain('officer at [to fill in].');
    });

    it('fills the parts it knows', () => {
        const form = { ...formFromSettings(OFF, NOW), surfaces: ['direct' as const, 'agent' as const], signals: ['outcomes' as const, 'kinds' as const], legal_basis: 'art6_1_f' as const, retention_days: '60' };
        const template = { dpoContact: 'dpo@example.org', dsrUrl: 'https://example.org/dsr', shieldLogRetentionDays: 0 };
        const text = noticeText(t, { form, template, orgName: 'Acme', startDay: '2026-10-14' }, 'en');
        expect(text).toContain('Chat signals at Acme');
        expect(text).toContain('in Direct chat, Agent chat.');
        expect(text).toContain('scan failed, and which kinds of personal data it found');
        expect(text).toContain('Legitimate interest (Art. 6(1)(f)). Our legitimate interest');
        expect(text).toContain('How long: 60 days. Counting starts on 14 October 2026.');
        expect(text).toContain('no time limit is set');
        expect(text).toContain('use https://example.org/dsr.');
        expect(text).toContain('officer at dpo@example.org.');
        expect(noticeText(t, { form, template: { ...template, shieldLogRetentionDays: 30 }, orgName: 'Acme', startDay: '' }, 'en')).toContain('kept for 30 days');
    });

    it('formats a UTC day whatever the clock', () => {
        expect(formatNoticeDate('2026-01-01', 'en')).toBe('1 January 2026');
        expect(formatNoticeDate('2026-01-01', 'nl')).toBe('1 januari 2026');
        expect(formatNoticeDate('2026-1-1')).toBe('');
        expect(formatNoticeDate(null)).toBe('');
    });

    it('previews the register entry from the form', () => {
        const form = { ...formFromSettings(OFF, NOW), surfaces: ['direct' as const, 'agent_public' as const], retention_days: '45' };
        const a = previewActivity(t, form);
        expect(a.retention.startsWith('45 days.')).toBe(true);
        expect(a.data_subjects).toEqual([
            'Employees and members using: Direct chat',
            'Website visitors who chat with an embedded agent',
            'People named in those messages (third parties)',
        ]);
        expect(a.data_categories).toHaveLength(2);
        expect(a.legal_basis).toBe('');
    });
});
