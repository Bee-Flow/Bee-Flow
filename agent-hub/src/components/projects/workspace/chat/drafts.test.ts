import { beforeEach, expect, it } from 'vitest';
import { clearDrafts, draftKey, readDraft, writeDraft } from './drafts';
import { rememberFirstAnswer, takeFirstAnswer } from './firstAnswer';
import { isImeEnter, isImeKey } from './ime';

beforeEach(() => clearDrafts());

it('keeps a draft per user, chat and thread, and forgets an emptied one', () => {
    const chat = draftKey('u1', 'c1');
    const thread = draftKey('u1', 'c1', 't1');
    writeDraft(chat, { text: 'main', picked: [] });
    writeDraft(thread, { text: 'in thread', picked: [] });
    expect(readDraft(chat)?.text).toBe('main');
    expect(readDraft(thread)?.text).toBe('in thread');
    expect(readDraft(draftKey('u2', 'c1'))).toBeNull();
    writeDraft(chat, { text: '  ', picked: [] });
    expect(readDraft(chat)).toBeNull();
    expect(readDraft(undefined)).toBeNull();
});

it('holds a bounded number of drafts, dropping the oldest', () => {
    for (let i = 0; i < 60; i++) writeDraft(draftKey('u', `c${i}`), { text: 'x', picked: [] });
    expect(readDraft(draftKey('u', 'c0'))).toBeNull();
    expect(readDraft(draftKey('u', 'c59'))).not.toBeNull();
});

it('hands the first answer of a new chat over once, and only while it is fresh', () => {
    rememberFirstAnswer('c1', { status: 'skipped', reason: 'limit' }, 'hi @ai', 1000);
    expect(takeFirstAnswer('c1', 2000)).toEqual({ ai: { status: 'skipped', reason: 'limit' }, askedAi: true });
    expect(takeFirstAnswer('c1', 2000)).toBeNull();
    rememberFirstAnswer('c2', { status: 'queued' }, 'hello', 1000);
    expect(takeFirstAnswer('c2', 1000 + 31_000)).toBeNull();
    rememberFirstAnswer('c3', null, 'hello');
    expect(takeFirstAnswer('c3')).toBeNull();
});

it('recognises the keys an IME handles, including Safari after compositionend', () => {
    expect(isImeEnter({ key: 'Enter', nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeEnter({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 229 })).toBe(true);
    expect(isImeEnter({ key: 'Enter', nativeEvent: { isComposing: false }, keyCode: 13 })).toBe(false);
    expect(isImeEnter({ key: 'a', keyCode: 229 })).toBe(false);
    expect(isImeKey({ key: 'ArrowDown', keyCode: 229 })).toBe(true);
});
