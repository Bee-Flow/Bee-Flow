/**
 * The two rules this app must not invent for itself: who may edit a skill, and
 * what an edit is allowed to send back.
 *
 * Both are server contracts, and both fail quietly when they drift — a missing
 * `canEdit` would paint an Edit button that 403s, and a text facet sent back
 * unedited would flatten structure the Studio built. Neither shows up as a
 * crash, so they are pinned here.
 */

import { canEditSkill, readableRefusal } from './api';
import { draftFromSkill, type Skill } from './types';
import { ApiError } from '../../api/client';
import { describeError } from '../../ui/Feedback';

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

describe('readableRefusal: Skills are Enterprise, and the plan screen says so in words', () => {
    // requireCapability's 403 puts a CODE in `error`, and the client takes
    // `error` as the message, so without this the screen read "feature_locked".
    const locked = () => new ApiError('feature_locked', {
        status: 403,
        body: { error: 'feature_locked', feature: 'skills', required: 'enterprise' },
    });

    it('turns the capability code into a sentence and keeps status and body', () => {
        const out = readableRefusal(locked());
        expect(out).toBeInstanceOf(ApiError);
        const err = out as ApiError;
        expect(err.status).toBe(403);
        expect(err.message).not.toBe('feature_locked');
        expect(err.message).toMatch(/Enterprise plan/);
        expect((err.body as { feature?: string }).feature).toBe('skills');
    });

    it('is what describeError prints under "Not available on your plan"', () => {
        const shown = describeError(readableRefusal(locked()));
        expect(shown.title).toBe('Not available on your plan');
        expect(shown.message).toMatch(/Enterprise plan/);
        expect(shown.retryable).toBe(false);
    });

    it('words the in-plan-but-not-granted refusal differently', () => {
        const disabled = new ApiError('feature_disabled', { status: 403, body: { error: 'feature_disabled', feature: 'skills' } });
        const err = readableRefusal(disabled) as ApiError;
        expect(err.message).not.toBe('feature_disabled');
        expect(err.message).not.toMatch(/Enterprise plan/);
    });

    it('leaves a refusal that already carries a sentence alone', () => {
        const sentence = 'Adding skills needs Skills, which is part of the Enterprise plan.';
        const fromServer = new ApiError(sentence, { status: 403, body: { error: sentence, code: 'feature_locked' } });
        expect(readableRefusal(fromServer)).toBe(fromServer);
        const notEditable = new ApiError('Not yours', { status: 403, body: { error: 'Not yours', code: 'not_editable' } });
        expect(readableRefusal(notEditable)).toBe(notEditable);
    });

    it('leaves every other error alone', () => {
        const missing = new ApiError('feature_locked', { status: 404, body: { error: 'feature_locked' } });
        expect(readableRefusal(missing)).toBe(missing);
        const plain = new Error('boom');
        expect(readableRefusal(plain)).toBe(plain);
    });
});
