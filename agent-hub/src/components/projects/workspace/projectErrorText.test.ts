import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/client';
import {
    ProjectRequestError, projectErrorFromResponse, projectErrorInfo, projectRequest, toProjectError,
} from '../../../api/queries/projectErrors';
import { projectErrorText } from './projectErrorText';

// The English fallback, interpolated: what t() renders before the catalogue loads.
const t = (_key: string, fallback?: unknown, params?: Record<string, unknown>) =>
    String(fallback ?? '').replace(/\{(\w+)\}/g, (_, k) => String(params?.[k] ?? `{${k}}`));

const refused = (status: number, body: unknown) => new ApiError('Request failed', { status, body });

describe('the data layer keeps what the server said', () => {
    it('keeps code, details and the sentence of a refusal', async () => {
        const err = await projectRequest('Could not delete', () => Promise.reject(refused(409, {
            error: 'Stop sharing the 2 shared chats first.', code: 'SHARED_CHATS_REMAIN', details: { sharedChats: 2 },
        }))).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ProjectRequestError);
        expect(err).toMatchObject({
            status: 409, code: 'SHARED_CHATS_REMAIN', details: { sharedChats: 2 },
            message: 'Stop sharing the 2 shared chats first.', serverMessage: 'Stop sharing the 2 shared chats first.',
        });
    });

    it('falls back to the caller’s sentence when the server sent none', () => {
        expect(toProjectError(new TypeError('Failed to fetch'), 'Could not save')).toMatchObject({ message: 'Could not save', serverMessage: null });
        expect(toProjectError(refused(500, null), 'Could not save')).toMatchObject({ message: 'Could not save', code: null, status: 500 });
    });

    it('reads a raw response body the same way', () => {
        expect(projectErrorInfo({ error: 'No.', code: 'KIND_NOT_ALLOWED' })).toEqual({ code: 'KIND_NOT_ALLOWED', details: null, message: 'No.' });
        expect(projectErrorFromResponse(409, { code: 'SOLUTION_HOLDS_NO_FILES' }, 'Could not upload')).toMatchObject({ status: 409, code: 'SOLUTION_HOLDS_NO_FILES', message: 'Could not upload' });
    });
});

describe('projectErrorText', () => {
    it('counts the chats that still hold a project up', () => {
        const err = (sharedChats?: number) => new ProjectRequestError('server words', { code: 'SHARED_CHATS_REMAIN', details: sharedChats === undefined ? null : { sharedChats } });
        expect(projectErrorText(t, err(1))).toMatch(/^One chat is still shared/);
        expect(projectErrorText(t, err(3))).toMatch(/^3 chats are still shared/);
        expect(projectErrorText(t, err())).toMatch(/^Chats are still shared/);
    });

    it('asks the people who shared the chats to act, not the reader', () => {
        // Only a chat's own owner can make it private again; the project owner
        // who is deleting cannot, so "stop sharing" addressed to them was wrong.
        const err = (sharedChats: number) => new ProjectRequestError('x', {
            code: 'SHARED_CHATS_REMAIN',
            details: { sharedChats, chats: [{ id: 'c1', type: 'direct', ownerId: 'bob' }] },
        });
        expect(projectErrorText(t, err(1))).toMatch(/The person who shared it has to make it private again first/);
        expect(projectErrorText(t, err(2))).toMatch(/The people who shared them have to make them private again first/);
        expect(projectErrorText(t, err(2))).not.toMatch(/Stop sharing/);
    });

    it('says what a project still holds that the other side refuses', () => {
        const held = (kind: string) => new ProjectRequestError('x', {
            code: 'KIND_HOLDS_OTHER_CONTENT', details: { kind, held: { apps: 1 } },
        });
        expect(projectErrorText(t, held('workspace'))).toMatch(/automations, apps, pages, tables or agents, which a project cannot hold/);
        expect(projectErrorText(t, held('solution'))).toMatch(/chats, documents, meeting notes or files, which a Studio Solution cannot hold/);
    });

    it('says which kind a project already has', () => {
        expect(projectErrorText(t, new ProjectRequestError('x', { code: 'KIND_ALREADY_SET', details: { kind: 'solution' } }))).toMatch(/already a Studio Solution/);
        expect(projectErrorText(t, new ProjectRequestError('x', { code: 'KIND_ALREADY_SET', details: { kind: 'workspace' } }))).toMatch(/already a project/);
    });

    it.each([
        ['KIND_NOT_ALLOWED', /cannot be added here/],
        ['SOLUTION_HOLDS_NO_CHATS', /holds no chats/],
        ['SOLUTION_HOLDS_NO_FILES', /no project files/],
        ['PROJECT_KEY_UNAVAILABLE', /encryption key/],
        ['document_read_only', /only the project’s editors/],
        ['document_owner_only', /Only the owner of this document/],
    ])('translates %s instead of repeating the server’s English', (code, expected) => {
        expect(projectErrorText(t, { error: 'English from the server', code })).toMatch(expected);
    });

    it.each([
        ['chat_archived', 'project_chat.archived_notice'],
        ['ai_mode_not_allowed', 'project_home.errors.ai_mode_not_allowed'],
        ['agent_unavailable', 'project_home.errors.agent_unavailable'],
        ['client_msg_id_taken', 'project_home.errors.client_msg_id_taken'],
        ['not_chat_creator', 'project_home.errors.not_chat_creator'],
        ['not_message_author', 'project_home.errors.not_message_author'],
        ['project_org_mismatch', 'project_home.errors.project_org_mismatch'],
        ['document_live', 'project_home.errors.document_live'],
        ['notebooks_unavailable', 'project_home.errors.notebooks_unavailable'],
        ['notebooks_unknown', 'project_home.errors.notebooks_unknown'],
    ])('says %s with a key of its own, never the server’s English (a Dutch reader reads Dutch)', (code, key) => {
        // A catalogue that knows the key: what a Dutch workspace renders.
        const dutch = (k: string, fallback?: unknown) => (k === key ? `NL:${k}` : String(fallback ?? ''));
        const sent = { error: 'This chat is archived. Restore it before posting.', code };
        expect(projectErrorText(dutch, sent)).toBe(`NL:${key}`);
        expect(projectErrorText(t, sent)).not.toBe(sent.error);
        expect(projectErrorText(t, new ApiError('Request failed', { status: 409, body: sent }))).not.toBe(sent.error);
    });

    it('keeps the server’s sentence for a code it does not know, then the fallback', () => {
        expect(projectErrorText(t, new ProjectRequestError('Not yours to move.', { code: 'not_owner', serverMessage: 'Not yours to move.' }))).toBe('Not yours to move.');
        expect(projectErrorText(t, {}, 'Could not add it')).toBe('Could not add it');
        expect(projectErrorText(t, null)).toBe('That did not work. Try again.');
    });

    it('puts the screen’s translated fallback before the data layer’s English one', () => {
        // No answer from the server (offline): the data layer's own English
        // sentence is only the Error's message, never what the reader sees.
        const offline = toProjectError(new TypeError('Failed to fetch'), 'Could not save the project');
        expect(projectErrorText(t, offline, 'Het project kon niet worden opgeslagen.')).toBe('Het project kon niet worden opgeslagen.');
        expect(projectErrorText(t, offline)).toBe('That did not work. Try again.');
    });
});
