// @vitest-environment node
//
// Lockstep tripwire: the bundled presentation catalog (courses.js / lessons.js)
// must structurally match the server's authoritative catalog
// (server/learning/courseCatalog.js). The server copy drives badge/certificate
// issuance and is served at runtime via GET /ai/learning/catalog; the bundled
// copy is the offline fallback — silent drift between them turns into
// badges-shown-but-never-issued bugs. This test makes drift a red build.

import { createRequire } from 'module';
import { describe, it, expect } from 'vitest';
import { COURSES, CERTIFICATES } from './courses';
import { LESSONS } from './lessons';

const require = createRequire(import.meta.url);
const serverCatalog = require('../../../../server/learning/courseCatalog.js');

describe('client/server catalog lockstep', () => {
    it('has the same course ids in the same order', () => {
        expect(serverCatalog.COURSES.map((c) => c.id)).toEqual(COURSES.map((c) => c.id));
    });

    it('agrees on lessonIds, track, prereqs and badge id per course', () => {
        for (const local of COURSES) {
            const server = serverCatalog.getCourse(local.id);
            expect(server, `course ${local.id} missing server-side`).toBeTruthy();
            expect(server.lessonIds, `lessonIds drift on ${local.id}`).toEqual(local.lessonIds);
            expect(server.track, `track drift on ${local.id}`).toBe(local.track);
            expect(server.prereqCourseIds || [], `prereq drift on ${local.id}`).toEqual(local.prereqCourseIds || []);
            expect(server.badge?.id, `badge id drift on ${local.id}`).toBe(local.badge?.id);
        }
    });

    it('agrees on certificate ids, tracks and rules', () => {
        expect(serverCatalog.CERTIFICATES.map((c) => c.id)).toEqual(CERTIFICATES.map((c) => c.id));
        for (const local of CERTIFICATES) {
            const server = serverCatalog.getCertificate(local.id);
            expect(server.track ?? null, `track drift on ${local.id}`).toBe(local.track ?? null);
            expect(server.rule ?? null, `rule drift on ${local.id}`).toEqual(local.rule ?? null);
        }
    });

    // Compared WHOLE rather than key by key. Listing the keys here is how a new
    // gate key slips through: `permissionsAll` shipped once with the client
    // enforcing it and the generator's `if (gate.permission || gate.feature)`
    // silently dropping it server-side, so the server believed the lesson was
    // visible to everyone and completion.js demanded it before minting a
    // certificate. An object comparison cannot miss the next one.
    it('mirrors every lesson gate server-side (LESSON_GATES)', () => {
        const nonEmpty = (g) => (g && Object.keys(g).length ? g : null);
        for (const lesson of LESSONS) {
            expect(nonEmpty(serverCatalog.LESSON_GATES[lesson.id]), `gate drift on ${lesson.id}`)
                .toEqual(nonEmpty(lesson.gate));
        }
        // No phantom server gates for lessons that don't exist client-side.
        const lessonIds = new Set(LESSONS.map((l) => l.id));
        for (const gatedId of Object.keys(serverCatalog.LESSON_GATES)) {
            expect(lessonIds.has(gatedId), `server gate for unknown lesson ${gatedId}`).toBe(true);
        }
    });

    it('whitelists exactly the client lesson ids (LESSON_IDS)', () => {
        const local = LESSONS.map((l) => l.id).sort();
        const server = [...serverCatalog.LESSON_IDS].sort();
        expect(server).toEqual(local);
    });

    it('maps every rubric exercise to a real lesson (EXERCISE_LESSONS)', () => {
        const lessonIds = new Set(LESSONS.map((l) => l.id));
        for (const [exerciseId, lessonId] of Object.entries(serverCatalog.EXERCISE_LESSONS)) {
            expect(lessonIds.has(lessonId), `${exerciseId} → unknown lesson ${lessonId}`).toBe(true);
        }
    });

    it('mirrors the practice-able lesson ids (PRACTICE_LESSON_IDS)', async () => {
        // The client mirror drives where the "Practice" button renders; the
        // server registry drives what the generator accepts. Drift = a button
        // that 400s, or a generator nobody can reach.
        const { PRACTICE_LESSON_IDS: serverIds } = require('../../../../server/learning/practiceTopics.js');
        const { PRACTICE_LESSON_IDS: clientIds } = await import('./reviewEngine');
        expect([...clientIds].sort()).toEqual([...serverIds].sort());
        const lessonIds = new Set(LESSONS.map((l) => l.id));
        for (const id of serverIds) {
            expect(lessonIds.has(id), `practice topic for unknown lesson ${id}`).toBe(true);
        }
    });
});
