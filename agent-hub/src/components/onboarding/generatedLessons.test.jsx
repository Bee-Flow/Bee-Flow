/**
 * The generated curriculum must actually PLAY. The catalog is machine-written
 * (.claude/handoff/curriculum -> generate.mjs), so a malformed step or a lesson
 * that never reached the LESSONS array would otherwise only surface when a
 * learner opened it. This mounts the real player on one lesson per audience and
 * asserts the chrome and the first step render.
 */
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })) }));
vi.mock('../licensing/LicenseContext', () => ({ useLicenseContext: () => ({ hasFeature: () => true }) }));
import LessonPlayer from './player/LessonPlayer';
import { LESSONS } from './lessons';

describe('generated lessons play in the real player', () => {
  const picks = ['chat-first-answer', 'automation-anatomy', 'shield-org-turn-on', 'apps-first-build', 'hive-master'];
  it.each(picks)('renders %s', (id) => {
    const l = LESSONS.find((x) => x.id === id);
    expect(l, `${id} missing from LESSONS`).toBeTruthy();
    expect(l.steps.length).toBeGreaterThanOrEqual(8);
    const { unmount, container } = render(
      <LessonPlayer lessonId={id} courseId={null} user={{ id: 'u1', permissions: ['all'] }} onClose={() => {}} onComplete={async () => ({})} />,
    );
    // The player's chrome is portalled to document.body; the title must appear.
    expect(document.body.textContent).toContain(l.titleFallback);
    // and a step counter proves a step body mounted
    expect(document.body.textContent).toMatch(/Step 1 of \d+/);
    unmount();
  });
});
