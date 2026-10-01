/**
 * Shared fixtures for "which field of the item goes into which input"
 * (match.mjs). The web builder's auto-map (agent-hub autoMapInputs.test.ts)
 * and the AI builder's auto-bind (server inputBindings.test.js) both run
 * every case here through their own code, so the two can no longer drift
 * apart on the same question.
 *
 * A case is a step that runs once per item of a list:
 *   item     one entry of that list (a sample)
 *   fanout   the list is the `results` of a step that itself ran once per
 *            item; `item` is then that step's own output, and a field of it
 *            is reached under `output.`
 *   inputs   the step's empty inputs, all required (the AI builder only
 *            binds required ones), with their JSON-schema type
 *   expect   per input, the path inside the item it is bound to, or null
 *   aiBuilder  where the AI builder's auto-bind differs from the web
 *            auto-map: the same shape as `expect`, for the inputs it names.
 *            Only the web leaves a secret-like input alone (skipSecrets): a
 *            value the author did not see bound must not route a credential,
 *            while the AI builder says in its warnings what it bound.
 *
 * Not a test file: it ships with the core so the copies in agent-hub and
 * mobile carry it too (the lockstep tests compare every file).
 */

export const MATCH_CASES = Object.freeze([
    {
        name: 'the same name binds',
        item: { messageId: 'm1', subject: 'Hi' },
        inputs: { messageId: { type: 'string' } },
        expect: { messageId: 'messageId' },
    },
    {
        name: 'snake and camel case are the same name',
        item: { message_id: 'm1', subject: 'Hi' },
        inputs: { messageId: { type: 'string' } },
        expect: { messageId: 'message_id' },
    },
    {
        name: 'an <entity>Id input takes the item\'s own id',
        item: { id: 'm1', subject: 'Hi', from: 'a@b.nl' },
        inputs: { messageId: { type: 'string' }, attachmentId: { type: 'string' } },
        expect: { messageId: 'id', attachmentId: null },
    },
    {
        name: 'the same name wins over the id link',
        item: { id: 'f1', fileId: 'x9', path: '/a.pdf' },
        inputs: { fileId: { type: 'string' }, path: { type: 'string' } },
        expect: { fileId: 'fileId', path: 'path' },
    },
    {
        name: 'nothing that fits binds nothing',
        item: { name: 'a.pdf', size: 10 },
        inputs: { content: { type: 'string' } },
        expect: { content: null },
    },
    {
        name: 'a secret-like input is left to the author on the web, and bound by name by the AI builder',
        item: { pageToken: 'p2', id: 'x' },
        inputs: { pageToken: { type: 'string' } },
        expect: { pageToken: null },
        aiBuilder: { pageToken: 'pageToken' },
    },
    {
        name: 'the item\'s own id wins over the id of an object inside it',
        item: { id: 'm1', subject: 'Hi', from: { id: 'u1', name: 'Jan' } },
        inputs: { messageId: { type: 'string' } },
        expect: { messageId: 'id' },
    },
    {
        name: 'a fan-out step\'s entries are read under output',
        fanout: true,
        item: { path: '/a.pdf', content: 'text' },
        inputs: { content: { type: 'string' } },
        expect: { content: 'output.content' },
    },
]);
