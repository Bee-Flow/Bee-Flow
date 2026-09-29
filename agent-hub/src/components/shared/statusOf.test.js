// @vitest-environment node
import { describe, it, expect } from 'vitest';
import statusOf, { STATUSES, normalizeStatus, automation, step, agent, kb, webpage, app } from './statusOf';

/**
 * One adapter per Studio kind, each a few lines — and each a place where a
 * header could quietly start lying about what the audience sees. These
 * tests pin the precedence rules the adapters copy from their sources
 * (BuilderShell's status label, BuilderHeader's step chip, audience.js's
 * is_published, EditorHeader's three-valued publish state).
 */

describe('statusOf — vocabulary', () => {
    it('knows exactly the six words the pill paints', () => {
        expect([...STATUSES].sort()).toEqual(['draft', 'live', 'paused', 'published', 'stale', 'unknown']);
    });

    it('normalises anything outside the vocabulary to unknown, never a throw', () => {
        for (const s of STATUSES) expect(normalizeStatus(s)).toBe(s);
        expect(normalizeStatus('banana')).toBe('unknown');
        expect(normalizeStatus('LIVE')).toBe('unknown');
        expect(normalizeStatus(undefined)).toBe('unknown');
        expect(normalizeStatus(null)).toBe('unknown');
    });

    it('exposes the adapters on the default object too', () => {
        expect(statusOf.automation).toBe(automation);
        expect(statusOf.step).toBe(step);
        expect(statusOf.agent).toBe(agent);
        expect(statusOf.kb).toBe(kb);
        expect(statusOf.webpage).toBe(webpage);
        expect(statusOf.app).toBe(app);
        expect(Object.isFrozen(statusOf)).toBe(true);
    });
});

describe('statusOf.automation — isDraft wins, then isActive', () => {
    it('live when active', () => {
        expect(automation({ isActive: true, isDraft: false })).toBe('live');
    });
    it('paused when finalised but switched off', () => {
        expect(automation({ isActive: false, isDraft: false })).toBe('paused');
    });
    it('draft when never finalised', () => {
        expect(automation({ isActive: false, isDraft: true })).toBe('draft');
    });
    it('keeps BuilderShell\'s precedence: a draft is a draft even if a row claims active', () => {
        expect(automation({ isActive: true, isDraft: true })).toBe('draft');
    });
    it('treats a missing row as paused, not a crash', () => {
        expect(automation(undefined)).toBe('paused');
        expect(automation({})).toBe('paused');
    });
});

describe('statusOf.step — a rolled-out version means published', () => {
    it('published once publishedVersion is set (0 counts: it is a version, not "none")', () => {
        expect(step({ publishedVersion: 3 })).toBe('published');
        expect(step({ publishedVersion: 0 })).toBe('published');
        expect(step({ published_version: 1 })).toBe('published');
    });
    it('draft while publishedVersion is null or absent', () => {
        expect(step({ publishedVersion: null })).toBe('draft');
        expect(step({})).toBe('draft');
        expect(step(undefined)).toBe('draft');
    });
});

describe('statusOf.agent / kb / webpage — is_published today, a version column tomorrow', () => {
    it('reads the explicit flag in either casing', () => {
        expect(agent({ is_published: true })).toBe('published');
        expect(agent({ isPublished: true })).toBe('published');
        expect(agent({ is_published: false })).toBe('draft');
        expect(kb({ is_published: true })).toBe('published');
        expect(kb({ is_published: false })).toBe('draft');
        expect(webpage({ is_published: true })).toBe('published');
        expect(webpage({ is_published: false })).toBe('draft');
    });

    it('lets the explicit flag win over a leftover version number (unpublished keeps its old version)', () => {
        expect(agent({ is_published: false, published_version: 4 })).toBe('draft');
        expect(webpage({ is_published: false, published_version_id: 'v_9' })).toBe('draft');
    });

    it('falls back to the version column when no flag is on the row (post A1 / W2 shape)', () => {
        expect(agent({ published_version: 2 })).toBe('published');
        expect(agent({ publishedVersion: 2 })).toBe('published');
        expect(agent({ published_version: null })).toBe('draft');
        expect(webpage({ published_version_id: 'v_1' })).toBe('published');
        expect(webpage({ publishedVersionId: 'v_1' })).toBe('published');
        expect(webpage({ published_version_id: null })).toBe('draft');
    });

    it('is draft for an empty or missing row', () => {
        expect(agent({})).toBe('draft');
        expect(kb(undefined)).toBe('draft');
        expect(webpage(null)).toBe('draft');
    });
});

describe('statusOf.app — mirrors EditorHeader\'s unknown | current | behind', () => {
    it('live when the published version matches the canvas ("current")', () => {
        expect(app({ version: 5, publishedVersion: 5, isPublished: true })).toBe('live');
        expect(app({ version: '5', published_version: 5, is_published: true })).toBe('live');
    });
    it('stale when the audience runs an older version ("behind")', () => {
        expect(app({ version: 6, publishedVersion: 5, isPublished: true })).toBe('stale');
    });
    it('unknown when not published — never a claim it cannot back', () => {
        expect(app({ version: 6, publishedVersion: 5, isPublished: false })).toBe('unknown');
        expect(app({ version: 6, publishedVersion: 5 })).toBe('unknown');
    });
    it('unknown when the row predates publishedVersion', () => {
        expect(app({ version: 6, isPublished: true })).toBe('unknown');
        expect(app({ version: 6, publishedVersion: null, isPublished: true })).toBe('unknown');
    });
    it('unknown when there is no canvas version to compare against', () => {
        expect(app({ publishedVersion: 5, isPublished: true })).toBe('unknown');
    });
    it('is unknown for an empty or missing row', () => {
        expect(app({})).toBe('unknown');
        expect(app(undefined)).toBe('unknown');
    });
});
