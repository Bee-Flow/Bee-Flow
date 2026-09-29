/**
 * The two rules this app must not invent for itself: who may edit a skill, and
 * what an edit is allowed to send back.
 *
 * Both are server contracts, and both fail quietly when they drift — a missing
 * `canEdit` would paint an Edit button that 403s, and a text facet sent back
 * unedited would flatten structure the Studio built. Neither shows up as a
 * crash, so they are pinned here.
 */

import { canEditSkill } from './api';
import { draftFromSkill, type Skill } from './types';

const skill = (over: Partial<Skill> = {}): Skill => ({
    id: 'sk1',
    orgId: 'org1',
    userId: 'u1',
    name: 'Sales tone',
    description: 'How we write to prospects.',
    instructions: 'Short sentences.',
    workflow: '1. Read the thread\n2. Draft',
    rules: 'Never promise a date.',
    examples: 'Good: “Thursday works.”',
    icon: '⚡',
    isShared: false,
    dynamicActivation: false,
    sharedGroups: [],
    automationId: null,
    enabledIntegrations: [],
    createdAt: null,
    updatedAt: null,
    ...over,
});

describe('canEditSkill — the server verdict, read fail-closed', () => {
    it('refuses when the row carries no verdict at all', () => {
        // A server older than Track S1 does not send `canEdit`. Unknown must
        // narrow to read-only: `skill.canEdit !== false` would have opened the
        // editor for every row such a server returns, including a colleague's.
        expect(canEditSkill(skill())).toBe(false);
    });

    it('refuses when the server says no', () => {
        expect(canEditSkill(skill({ canEdit: false }))).toBe(false);
    });

    it('allows when the server says yes — even on a row this session does not own', () => {
        // The point of moving the rule server-side: `manage_skills` in the
        // skill's own org edits a colleague's shared skill, which the old local
        // owner-only rule refused while PUT accepted it.
        expect(canEditSkill(skill({ userId: 'someone-else', canEdit: true }))).toBe(true);
    });

    it('is not fooled by a truthy non-boolean', () => {
        // Whatever a proxy or an older shape puts there, only a real `true`
        // from the server counts as permission.
        expect(canEditSkill(skill({ canEdit: 'yes' as unknown as boolean }))).toBe(false);
    });
});

describe('draftFromSkill — a facet the Studio owns is never sent back', () => {
    it('keeps all six text fields when nothing is parsed yet', () => {
        // mapRow presents a NULL structured column as [] (skillStore.js:847),
        // so an empty list means "not migrated" as much as "empty". Dropping a
        // facet on [] would make every pre-S1 skill uneditable from the phone.
        const draft = draftFromSkill(skill({ steps: [], rulesV2: [], examplesV2: [] }));
        expect(draft.workflow).toBe('1. Read the thread\n2. Draft');
        expect(draft.rules).toBe('Never promise a date.');
        expect(draft.examples).toBe('Good: “Thursday works.”');
        expect(draft.name).toBe('Sales tone');
        expect(draft.description).toBe('How we write to prospects.');
        expect(draft.instructions).toBe('Short sentences.');
    });

    it('keeps all six when the structured fields are absent entirely', () => {
        expect(Object.keys(draftFromSkill(skill())).sort()).toEqual([
            'description', 'dynamicActivation', 'examples', 'icon',
            'instructions', 'isShared', 'name', 'rules', 'workflow',
        ]);
    });

    it('drops ONLY the workflow text when the skill has steps', () => {
        // resolveBodyWrite (skillStructure.js:456-482) re-parses every text it
        // is given, and parseWorkflowToSteps (:131-138) returns refs: [] with
        // fresh ids — so sending unedited workflow text is a silent wipe. The
        // two facets that are still text must survive: dropping them too would
        // make a rename unable to fix a typo in the rules.
        const draft = draftFromSkill(skill({ steps: [{ id: 's1', text: 'Read the thread', refs: ['kb1'] }] }));
        expect('workflow' in draft).toBe(false);
        expect(draft.rules).toBe('Never promise a date.');
        expect(draft.examples).toBe('Good: “Thursday works.”');
        expect(draft.name).toBe('Sales tone');
    });

    it('drops each facet on its own', () => {
        const onlyRules = draftFromSkill(skill({ rulesV2: [{ id: 'r1', text: 'no dates', mode: 'never' }] }));
        expect('rules' in onlyRules).toBe(false);
        expect(onlyRules.workflow).toBeDefined();
        expect(onlyRules.examples).toBeDefined();

        const onlyExamples = draftFromSkill(skill({ examplesV2: [{ id: 'e1', good: 'x' }] }));
        expect('examples' in onlyExamples).toBe(false);
        expect(onlyExamples.workflow).toBeDefined();
        expect(onlyExamples.rules).toBeDefined();
    });

    it('omits the key rather than sending undefined, so PUT reads it as "leave as-is"', () => {
        // JSON.stringify drops an undefined VALUE too, but `in` is what the
        // form reads to decide whether to offer the field at all.
        const draft = draftFromSkill(skill({ steps: [{ id: 's1' }], rulesV2: [{ id: 'r1' }], examplesV2: [{ id: 'e1' }] }));
        expect(JSON.parse(JSON.stringify(draft))).toEqual({
            name: 'Sales tone',
            description: 'How we write to prospects.',
            instructions: 'Short sentences.',
            icon: '⚡',
            isShared: false,
            dynamicActivation: false,
        });
    });
});
