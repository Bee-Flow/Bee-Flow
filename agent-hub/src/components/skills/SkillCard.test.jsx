import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import SkillCard from './SkillCard';

/**
 * A switchable dictionary over the REAL useTranslation, off by default so the
 * plain runs read the shipped English.
 *
 * The override is the whole point. This card was opened by the i18n pass and
 * left half-done: the Use/Active toggle went through t() while the badges, the
 * three icon tooltips, the destructive Delete/Cancel confirmation and the four
 * expanded field headings stayed hardcoded. Hardcoded English and translated
 * English render identically, so the only way to show a string now travels
 * through a KEY is to make that key answer in Dutch and watch the screen change.
 */
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null } }));
vi.mock('../../hooks/useTranslation', async (importOriginal) =>
  (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

const SKILL = {
  id: 's1',
  name: 'Invoice triage',
  description: 'Sorts invoices',
  instructions: 'Read the invoice',
  workflow: 'Step one',
  rules: 'Never guess',
  examples: 'An example',
};

const renderCard = (props = {}) => render(
  <SkillCard skill={SKILL} isOwner isActive={false} onToggle={vi.fn()} onEdit={vi.fn()} onDelete={vi.fn()} {...props} />,
);

describe('SkillCard — every visible word goes through a key', () => {
  beforeEach(() => { cleanup(); transOverride.current = null; });

  it('translates the shared badge', () => {
    transOverride.current = { 'skills.badge_shared': 'gedeeld' };
    renderCard({ skill: { ...SKILL, isShared: true } });
    expect(screen.getByText('gedeeld')).toBeTruthy();
    expect(screen.queryByText('shared')).toBeNull();
  });

  it('translates the private badge', () => {
    transOverride.current = { 'skills.badge_private': 'privé' };
    renderCard();
    expect(screen.getByText('privé')).toBeTruthy();
    expect(screen.queryByText('private')).toBeNull();
  });

  it('translates the attachment count and carries the number as a parameter', () => {
    // The count must arrive as {count}, not as a JSX sibling of an English
    // word: Dutch puts the number in the same place, but a language that does
    // not cannot be served by "word + {number}".
    transOverride.current = { 'skills.attached_to': 'gekoppeld aan {count} agents' };
    renderCard({ attachedAgentCount: 3 });
    expect(screen.getByText('gekoppeld aan 3 agents')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/attached to/);
    expect(document.body.textContent).not.toMatch(/\{count\}/);
  });

  it('translates the three icon tooltips', () => {
    transOverride.current = {
      'skills.show_details': 'Details tonen',
      'skills.edit_skill': 'Vaardigheid bewerken',
      'skills.delete_skill': 'Vaardigheid verwijderen',
    };
    renderCard();
    expect(screen.getByTitle('Details tonen')).toBeTruthy();
    expect(screen.getByTitle('Vaardigheid bewerken')).toBeTruthy();
    expect(screen.getByTitle('Vaardigheid verwijderen')).toBeTruthy();
    expect(screen.queryByTitle('Show details')).toBeNull();
  });

  it('translates the destructive confirmation — the two buttons that matter most', () => {
    // Delete/Cancel were the worst of the twelve: a half-Dutch card whose
    // irreversible choice was still in English. Both keys already exist in
    // both dictionaries, so this needed no new copy at all.
    transOverride.current = { 'common.delete': 'Verwijderen', 'common.cancel': 'Annuleren' };
    renderCard();
    fireEvent.click(screen.getByTitle('Delete skill'));
    expect(screen.getByText('Verwijderen')).toBeTruthy();
    expect(screen.getByText('Annuleren')).toBeTruthy();
    expect(screen.queryByText('Delete')).toBeNull();
    expect(screen.queryByText('Cancel')).toBeNull();
  });

  it('deletes with the skill id once the confirmation is confirmed', () => {
    // Translating a destructive control must not change what it does.
    const onDelete = vi.fn();
    renderCard({ onDelete });
    fireEvent.click(screen.getByTitle('Delete skill'));
    fireEvent.click(screen.getByText('Delete'));
    expect(onDelete).toHaveBeenCalledWith('s1');
  });

  it('translates the four expanded field headings', () => {
    // FieldPreview renders `label` verbatim into a div, so the translation has
    // to happen at the call site — handing it a key would print the key.
    transOverride.current = {
      'skills.field_instructions': 'Instructies',
      'skills.field_workflow': 'Werkwijze',
      'skills.field_rules': 'Regels',
      'skills.field_examples': 'Voorbeelden',
    };
    renderCard();
    fireEvent.click(screen.getByTitle('Show details'));
    for (const word of ['Instructies', 'Werkwijze', 'Regels', 'Voorbeelden']) {
      expect(screen.getByText(word)).toBeTruthy();
    }
    for (const word of ['Instructions', 'Workflow', 'Rules', 'Examples']) {
      expect(screen.queryByText(word)).toBeNull();
    }
  });

  it('never renders a bare key on the English path', () => {
    renderCard({ attachedAgentCount: 2, skill: { ...SKILL, isShared: true } });
    fireEvent.click(screen.getByTitle('Show details'));
    expect(document.body.textContent).not.toMatch(/\b(skills|common)\.[a-z_]+\b/);
  });
});
