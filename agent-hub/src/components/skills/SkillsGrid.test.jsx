import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SkillsGrid from './SkillsGrid';

/**
 * A switchable dictionary over the REAL useTranslation, off by default so the
 * plain runs read the shipped English.
 *
 * The override is what makes these assertions mean anything. This grid was
 * hardcoded English, and hardcoded English and translated English render
 * identically — the only way to show a string now travels through a KEY is to
 * make that key answer in another language and watch the screen change.
 */
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../hooks/useTranslation', async (importOriginal) =>
  (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

const USER = { id: 'u1' };
const skill = (id, name) => ({ id, name, description: `${name} does things`, userId: 'u1', isShared: false });

function renderGrid(props = {}) {
  return render(
    <SkillsGrid
      user={USER}
      skills={[]}
      loading={false}
      error={null}
      onCreate={vi.fn()}
      onToggleSkill={vi.fn()}
      {...props}
    />,
  );
}

describe('SkillsGrid — the panel speaks through t()', () => {
  beforeEach(() => { cleanup(); transOverride.current = null; });

  it('renders the empty state as a sentence, never a bare key', () => {
    renderGrid();
    expect(screen.getByText('No skills yet')).toBeTruthy();
    expect(screen.getByText('Create your first skill to teach the AI how to handle specific tasks consistently.')).toBeTruthy();
    // The failure this guards against is a key leaking onto the screen.
    expect(document.body.textContent).not.toMatch(/\b(skills|agent_skills)\.[a-z_]+\b/);
  });

  it('translates the empty state, header and CTA', () => {
    transOverride.current = {
      'skills.title': 'Vaardigheden',
      'skills.subtitle': 'Herbruikbare instructiepakketten',
      'agent_skills.none': 'Nog geen vaardigheden',
      'skills.none_help': 'Maak er een om te beginnen met lesgeven.',
      'skills.create_first': 'Maak je eerste vaardigheid',
      'agent_skills.new': 'Nieuwe vaardigheid',
    };
    renderGrid();
    expect(screen.getByText('Vaardigheden')).toBeTruthy();
    expect(screen.getByText('Herbruikbare instructiepakketten')).toBeTruthy();
    expect(screen.getByText('Nog geen vaardigheden')).toBeTruthy();
    expect(screen.getByText('Maak er een om te beginnen met lesgeven.')).toBeTruthy();
    expect(screen.getByText('Maak je eerste vaardigheid')).toBeTruthy();
    expect(screen.getByText('Nieuwe vaardigheid')).toBeTruthy();
    expect(screen.queryByText('No skills yet')).toBeNull();
  });

  it('shows the no-match copy, not the no-skills copy, once a search is typed', () => {
    transOverride.current = {
      'agent_skills.no_match': 'Niets gevonden',
      'agent_skills.no_match_help': 'Probeer een andere zoekterm.',
      'agent_skills.search': 'Zoek vaardigheden…',
    };
    renderGrid({ skills: [skill('s1', 'Meeting summary')] });
    fireEvent.change(screen.getByPlaceholderText('Zoek vaardigheden…'), { target: { value: 'zzz' } });
    expect(screen.getByText('Niets gevonden')).toBeTruthy();
    expect(screen.getByText('Probeer een andere zoekterm.')).toBeTruthy();
  });

  it('translates the filter chips, which travel as a DATA table', () => {
    // FILTERS is a module-level array; before this change its `label` was the
    // rendered string. A table like that is invisible to the i18n guard, so
    // the only proof it is translatable is a dictionary that moves it.
    transOverride.current = {
      'skills.filter_all': 'Alle',
      'skills.filter_mine': 'Mijn',
      'skills.filter_shared': 'Gedeeld',
      'skills.filter_attached': 'Gekoppeld',
    };
    renderGrid();
    for (const label of ['Alle', 'Mijn', 'Gedeeld', 'Gekoppeld']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy();
    }
    expect(screen.queryByRole('button', { name: 'All' })).toBeNull();
  });

  it('still filters on the chip it renders — a translated label keeps its id', () => {
    transOverride.current = { 'skills.filter_shared': 'Gedeeld' };
    renderGrid({
      skills: [skill('s1', 'Mine only'), { ...skill('s2', 'Shared one'), isShared: true }],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gedeeld' }));
    expect(screen.getByText('Shared one')).toBeTruthy();
    expect(screen.queryByText('Mine only')).toBeNull();
  });
});

describe('SkillsGrid — "n skills active in chat" is a choice of KEY', () => {
  beforeEach(() => { cleanup(); transOverride.current = null; });

  it('picks a different key for one than for many', () => {
    // House rule: no grammar in code. `skill${n !== 1 ? 's' : ''}` reads fine
    // in English and cannot be translated at all — the dictionary is handed
    // "skill" and has no say over the "s" welded on afterwards. Two forms are
    // two keys. The two dictionary values below share no word, so a component
    // that patched one string could not produce both.
    transOverride.current = {
      'skills.active_in_chat': '{count} vaardigheid staat aan',
      'skills.active_in_chat_plural': 'er staan {count} vaardigheden aan',
    };
    renderGrid({ skills: [skill('s1', 'A')], activeSkillIds: ['s1'] });
    expect(screen.getByText('1 vaardigheid staat aan')).toBeTruthy();

    cleanup();
    renderGrid({ skills: [skill('s1', 'A'), skill('s2', 'B')], activeSkillIds: ['s1', 's2'] });
    expect(screen.getByText('er staan 2 vaardigheden aan')).toBeTruthy();
  });

  it('reads as real English in both forms', () => {
    renderGrid({ skills: [skill('s1', 'A')], activeSkillIds: ['s1'] });
    expect(screen.getByText('1 skill active in chat')).toBeTruthy();
    cleanup();
    renderGrid({ skills: [skill('s1', 'A'), skill('s2', 'B')], activeSkillIds: ['s1', 's2'] });
    expect(screen.getByText('2 skills active in chat')).toBeTruthy();
  });

  it('hides the strip entirely when nothing is active', () => {
    renderGrid({ skills: [skill('s1', 'A')], activeSkillIds: [] });
    expect(screen.queryByText(/active in chat/)).toBeNull();
  });
});
