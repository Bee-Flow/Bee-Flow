import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SkillsPopover from './SkillsPopover';

/**
 * A switchable dictionary over the REAL useTranslation, off by default so the
 * plain runs read the shipped English fallbacks.
 *
 * Same device as SkillsGrid.test.jsx, and for the same reason: this popover
 * was hardcoded English, and hardcoded English renders identically to
 * translated English. The only way to PROVE a string now travels through a
 * key is to make that key answer in another language and watch the screen
 * change.
 */
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../hooks/useTranslation', async (importOriginal) =>
  (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

// useSkills fetches `${API_BASE}/api/skills` on mount, so it is stubbed
// outright — these are render tests and must never touch the network.
const { skillsState } = vi.hoisted(() => ({ skillsState: { current: { skills: [], loading: false } } }));
vi.mock('../../hooks/useSkills', () => ({
  useSkills: () => ({
    skills: skillsState.current.skills,
    loading: skillsState.current.loading,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
  invalidateSkills: vi.fn(),
}));

// A flat replacement, deliberately NOT `importOriginal()`: useTranslation.jsx
// imports from this same module, so asking for the original here while the
// useTranslation mock above resolves its own original wedges the graph.
// SkillFormModal.test.jsx stubs it the same flat way. The not-ok response
// keeps the popover's own session-skill refresh from replacing the
// props-provided stages, so the rows under test stay exactly as passed in.
vi.mock('../../utils/helpers', () => ({
  API_BASE: '',
  authFetch: vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
}));

const USER = { id: 'u1' };

// Shared, STABLE empties. The component's own `directSessionSkills = []`
// default parameter mints a fresh array on every render, and the effect that
// mirrors it into state has that array as its only dependency — so a render
// that leaves the prop out never settles. Passing one identity keeps these
// tests about the strings; the default itself is reported, not patched here.
const NO_STAGES = [];
const NO_IDS = [];

// s1 done (activated, activated downstream), s2 active (activated, terminal
// step not reached), s3 ready (deps met), s4 waiting (depends on s3).
const STAGES = [
  { id: 's1', order: 1, name: 'Gather sources', description: 'Collect the inputs', dependsOn: [] },
  { id: 's2', order: 2, name: 'Draft outline', description: 'Sketch the shape', dependsOn: ['s1'] },
  { id: 's3', order: 3, name: 'Write it up', description: 'Full prose', dependsOn: ['s2'] },
  { id: 's4', order: 4, name: 'Final review', description: 'Check it over', dependsOn: ['s3'] },
];
const ACTIVATED = ['s1', 's2'];

function renderPopover(props = {}) {
  return render(
    <SkillsPopover
      user={USER}
      open
      onOpenChange={vi.fn()}
      onToggleSkill={vi.fn()}
      directSessionSkills={NO_STAGES}
      directActivatedSessionSkillIds={NO_IDS}
      {...props}
    />,
  );
}

const renderDirect = (extra = {}) => renderPopover({
  directMode: true,
  directConversationId: 'c1',
  directSessionSkills: STAGES,
  directActivatedSessionSkillIds: ACTIVATED,
  ...extra,
});

const NO_BARE_KEY = /\b(skills|agent_skills)\.[a-z_]+\b/;

const reset = () => {
  cleanup();
  transOverride.current = null;
  skillsState.current = { skills: [], loading: false };
};

describe('SkillsPopover — header, search and empty state speak through t()', () => {
  beforeEach(reset);

  it('reads as real English and never leaks a raw key', () => {
    renderPopover();
    expect(screen.getByText('Skills')).toBeTruthy();
    expect(screen.getByText('0/5 active')).toBeTruthy();
    expect(screen.getByText('Toggle reusable instruction packs for this chat')).toBeTruthy();
    expect(screen.getByPlaceholderText('Search skills…')).toBeTruthy();
    expect(screen.getByText('No skills match your search')).toBeTruthy();
    expect(screen.getByText('Create new skill')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(NO_BARE_KEY);
  });

  it('translates the heading, the cap counter, the hint, the search box and the CTA', () => {
    transOverride.current = {
      'skills.title': 'Vaardigheden',
      'skills.cap_active': '{count} van {max} aan',
      'skills.popover_hint': 'Schakel herbruikbare instructiepakketten in voor deze chat',
      'agent_skills.search': 'Zoek vaardigheden…',
      'agent_skills.no_match': 'Niets gevonden',
      'skills.create_new': 'Nieuwe vaardigheid maken',
    };
    renderPopover();
    expect(screen.getByText('Vaardigheden')).toBeTruthy();
    // The trigger button's tooltip rides the same key as the heading.
    expect(screen.getByTitle('Vaardigheden')).toBeTruthy();
    expect(screen.getByText('0 van 5 aan')).toBeTruthy();
    expect(screen.getByText('Schakel herbruikbare instructiepakketten in voor deze chat')).toBeTruthy();
    expect(screen.getByPlaceholderText('Zoek vaardigheden…')).toBeTruthy();
    expect(screen.getByText('Niets gevonden')).toBeTruthy();
    expect(screen.getByText('Nieuwe vaardigheid maken')).toBeTruthy();
    expect(screen.queryByText('Skills')).toBeNull();
    expect(screen.queryByText('No skills match your search')).toBeNull();
  });

  it('translates the loading line while the first fetch is still out', () => {
    skillsState.current = { skills: [], loading: true };
    transOverride.current = { 'agent_skills.loading': 'Vaardigheden laden…' };
    renderPopover();
    expect(screen.getByText('Vaardigheden laden…')).toBeTruthy();
    expect(screen.queryByText('Loading skills…')).toBeNull();
  });

  it('counts the attached skills into the cap pill through one key', () => {
    skillsState.current = { skills: [{ id: 'a1', name: 'Summarise', description: 'd', isShared: false }], loading: false };
    transOverride.current = { 'skills.cap_active': '{count}/{max} actief' };
    renderPopover({ attachedSkillIds: ['a1'], activeSkillIds: [] });
    expect(screen.getByText('1/5 actief')).toBeTruthy();
  });
});

describe('SkillsPopover — the attached-by-agent marker is a key, not a literal', () => {
  beforeEach(() => {
    reset();
    skillsState.current = { skills: [{ id: 'a1', name: 'Summarise', description: 'Shortens things', isShared: false }], loading: false };
  });

  it('reads as English by default', () => {
    renderPopover({ attachedSkillIds: ['a1'] });
    expect(screen.getByTitle('Attached by agent')).toBeTruthy();
  });

  it('follows the dictionary', () => {
    transOverride.current = { 'skills.attached_by_agent': 'Gekoppeld door agent' };
    renderPopover({ attachedSkillIds: ['a1'] });
    expect(screen.getByTitle('Gekoppeld door agent')).toBeTruthy();
    expect(screen.queryByTitle('Attached by agent')).toBeNull();
  });
});

describe('SkillsPopover — the Flow Stages heading and progress pill', () => {
  beforeEach(reset);

  it('reads as real English: heading, progress pill, four state pills, delete tooltip', () => {
    renderDirect();
    expect(screen.getByText('Flow Stages')).toBeTruthy();
    expect(screen.getByText('1/4 done')).toBeTruthy();
    expect(screen.getByTitle('1 completed · 1 active · 2 pending')).toBeTruthy();
    expect(screen.getByText('Active')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('Needs Write it up')).toBeTruthy();
    expect(screen.getAllByTitle('Delete from this conversation')).toHaveLength(4);
    expect(document.body.textContent).not.toMatch(NO_BARE_KEY);
  });

  it('translates the heading and both halves of the progress pill', () => {
    transOverride.current = {
      'skills.flow_stages': 'Flow-fases',
      'skills.flow_progress': '{done} van {total} klaar',
      'skills.flow_progress_title': '{done} af · {active} bezig · {pending} te doen',
    };
    renderDirect();
    expect(screen.getByText('Flow-fases')).toBeTruthy();
    expect(screen.getByText('1 van 4 klaar')).toBeTruthy();
    // `pending` is computed in JS and handed over as a parameter — the summary
    // is one sentence in the dictionary, not three fragments glued together.
    expect(screen.getByTitle('1 af · 1 bezig · 2 te doen')).toBeTruthy();
    expect(screen.queryByText('Flow Stages')).toBeNull();
    expect(screen.queryByText('1/4 done')).toBeNull();
  });

  it('picks the all-done key once every stage is complete', () => {
    // s4 is terminal, so activating the whole chain marks them all done.
    transOverride.current = { 'skills.flow_all_done': 'Alles klaar: {done}/{total}' };
    renderDirect({ directActivatedSessionSkillIds: ['s1', 's2', 's3', 's4'] });
    expect(screen.getByText('Alles klaar: 4/4')).toBeTruthy();
    expect(screen.queryByText(/\d+\/\d+ done/)).toBeNull();
  });

  it('translates the two empty-state lines of the Flow section', () => {
    transOverride.current = { 'skills.flow_none': 'Nog geen Flow-fases voor deze chat.' };
    renderDirect({ directSessionSkills: NO_STAGES, directActivatedSessionSkillIds: NO_IDS });
    expect(screen.getByText('Nog geen Flow-fases voor deze chat.')).toBeTruthy();

    cleanup();
    transOverride.current = { 'skills.flow_send_first': 'Stuur het eerste bericht om Flow-fases te maken.' };
    renderPopover({ directMode: true, directConversationId: null });
    expect(screen.getByText('Stuur het eerste bericht om Flow-fases te maken.')).toBeTruthy();
    expect(screen.queryByText('Send the first message to generate Flow stages.')).toBeNull();
  });
});

describe('SkillsPopover — the four lifecycle pills', () => {
  beforeEach(reset);

  it('translates label and tooltip alike, for every state', () => {
    transOverride.current = {
      'skills.state_active': 'Actief',
      'skills.state_active_title': 'Geactiveerd en nu in beeld',
      'skills.state_done': 'Klaar',
      'skills.state_done_title': 'Werk af, volledige tekst niet meer meegestuurd',
      'skills.state_ready': 'Gereed',
      'skills.state_ready_title': 'Klaar om op verzoek te activeren',
      'skills.state_needs': 'Wacht op {names}',
      'skills.state_needs_title': 'Hangt af van: {names}',
    };
    renderDirect();
    expect(screen.getByText('Actief')).toBeTruthy();
    expect(screen.getByTitle('Geactiveerd en nu in beeld')).toBeTruthy();
    expect(screen.getByText('Klaar')).toBeTruthy();
    expect(screen.getByTitle('Werk af, volledige tekst niet meer meegestuurd')).toBeTruthy();
    expect(screen.getByText('Gereed')).toBeTruthy();
    expect(screen.getByTitle('Klaar om op verzoek te activeren')).toBeTruthy();
    // The dependency NAMES are joined in JS and handed to the key as one
    // parameter — the sentence around them belongs to the translator.
    expect(screen.getByText('Wacht op Write it up')).toBeTruthy();
    expect(screen.getByTitle('Hangt af van: Write it up')).toBeTruthy();
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.queryByText('Ready')).toBeNull();
  });

  it('translates the delete tooltip on every stage row', () => {
    transOverride.current = { 'skills.delete_from_conversation': 'Verwijderen uit dit gesprek' };
    renderDirect();
    expect(screen.getAllByTitle('Verwijderen uit dit gesprek')).toHaveLength(4);
    expect(screen.queryByTitle('Delete from this conversation')).toBeNull();
  });
});

describe('SkillsPopover — the expanded stage detail labels speak through t()', () => {
  beforeEach(reset);

  const DETAILED = [{
    id: 's1', order: 1, name: 'Gather sources', description: 'Collect the inputs', dependsOn: [],
    instructions: 'Do the thing', workflow: 'Step by step', rules: 'Never guess', examples: 'Like so',
  }];

  const openDetail = () => {
    renderPopover({
      directMode: true,
      directConversationId: 'c1',
      directSessionSkills: DETAILED,
    });
    fireEvent.click(screen.getByText('Gather sources'));
  };

  it('reads as English by default', () => {
    openDetail();
    for (const label of ['Instructions', 'Workflow', 'Rules', 'Examples']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('follows the dictionary on all four field labels', () => {
    transOverride.current = {
      'skills.field_instructions': 'Instructies',
      'skills.field_workflow': 'Werkstroom',
      'skills.field_rules': 'Regels',
      'skills.field_examples': 'Voorbeelden',
    };
    openDetail();
    for (const label of ['Instructies', 'Werkstroom', 'Regels', 'Voorbeelden']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.queryByText('Instructions')).toBeNull();
  });
});
