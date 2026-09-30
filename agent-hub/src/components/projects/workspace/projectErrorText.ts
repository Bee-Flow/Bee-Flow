// A refused project request, said in the reader's language.
//
// The server's refusals carry a stable code next to an English sentence
// (api/queries/projectErrors.ts). The codes the workspace, the chat list and
// Studio can run into each get a sentence here; any other refusal keeps the
// server's own sentence, and one with no sentence at all gets the caller's
// fallback. The server's sentence is always English, so a code a screen can
// reach belongs in this list, not in the fallback.

import { projectErrorInfo } from '../../../api/queries/projectErrors';
import type { TranslateFn } from '../../../hooks/useTranslation';

// Only a chat's own owner can make it private again (it is re-encrypted
// under their key), so the sentence says who has to act, not "you".
function sharedChatsRemain(t: TranslateFn, details: Record<string, unknown> | null): string {
    const count = Number(details?.sharedChats);
    if (count === 1) {
        return t('project_home.errors.shared_chats_remain_one', 'One chat is still shared with this project. The person who shared it has to make it private again first: a shared chat cannot outlive its project.');
    }
    if (Number.isFinite(count) && count > 1) {
        return t('project_home.errors.shared_chats_remain_many', '{count} chats are still shared with this project. The people who shared them have to make them private again first: a shared chat cannot outlive its project.', { count });
    }
    return t('project_home.errors.shared_chats_remain', 'Chats are still shared with this project. The people who shared them have to make them private again first: a shared chat cannot outlive its project.');
}

function kindAlreadySet(t: TranslateFn, details: Record<string, unknown> | null): string {
    if (details?.kind === 'solution') {
        return t('project_home.errors.kind_already_solution', 'This is already a Studio Solution. Whether something is a project or a Solution is decided once.');
    }
    if (details?.kind === 'workspace') {
        return t('project_home.errors.kind_already_workspace', 'This is already a project. Whether something is a project or a Solution is decided once.');
    }
    return t('project_home.errors.kind_already_set', 'This has already been classified. Whether something is a project or a Solution is decided once.');
}

function kindHoldsOtherContent(t: TranslateFn, details: Record<string, unknown> | null): string {
    if (details?.kind === 'solution') {
        return t('project_home.errors.kind_holds_project_content', 'This still holds chats, documents, meeting notes or files, which a Studio Solution cannot hold. Take them out first, then try again.');
    }
    return t('project_home.errors.kind_holds_solution_content', 'This still holds automations, apps, pages, tables or agents, which a project cannot hold. Take them out under Studio → Solutions first, then try again.');
}

/** Refusals of team chats, their messages, and content made in a project. */
function chatOrContentText(t: TranslateFn, code: string | null): string | null {
    switch (code) {
        case 'board_changed': return t('project_tasks.board_changed', 'The board changed. Close and reopen the column settings before saving.');
        case 'column_not_empty': return t('project_tasks.column_not_empty', 'Move all tasks out of this column before removing it or changing its status.');
        case 'invalid_columns': return t('project_tasks.invalid_columns', 'Keep at least one column for each status, with unique names.');
        case 'invalid_position': return t('project_tasks.invalid_position', 'The destination changed. Refresh the board and try again.');
        case 'chat_archived':
            return t('project_chat.archived_notice', 'This chat is archived. Restore it to post again.');
        case 'ai_mode_not_allowed':
            return t('project_home.errors.ai_mode_not_allowed', 'Your organisation does not allow this AI mode here. Choose another one.');
        case 'agent_unavailable':
            return t('project_home.errors.agent_unavailable', 'That agent is not available to you. Choose another agent.');
        case 'client_msg_id_taken':
            return t('project_home.errors.client_msg_id_taken', 'This message clashed with another one and was not sent. Copy your text and send it again.');
        case 'not_chat_creator':
            return t('project_home.errors.not_chat_creator', 'Only the person who started this chat or the project owner can delete it.');
        case 'not_message_author':
            return t('project_home.errors.not_message_author', 'Only the person who wrote this message can change it; the project owner can also delete it.');
        case 'project_org_mismatch':
            return t('project_home.errors.project_org_mismatch', 'This project belongs to another organisation, so nothing you make can be filed in it.');
        case 'document_live':
            return t('project_home.errors.document_live', 'This page is being edited live. Reload it to join in; your text was not saved over it.');
        case 'notebooks_unavailable':
            return t('project_home.errors.notebooks_unavailable', 'Notebooks are not available to you: your plan or your role does not include them.');
        case 'notebooks_unknown':
            return t('project_home.errors.notebooks_unknown', 'Whether notebooks are available to you could not be checked. Try again in a moment.');
        default:
            return null;
    }
}

/**
 * The sentence to show for a refused project request. `source` is what was
 * thrown (or, for callers that use fetch directly, the response body).
 */
export function projectErrorText(t: TranslateFn, source: unknown, fallback?: string): string {
    const { code, details, message } = projectErrorInfo(source);
    const known = chatOrContentText(t, code);
    if (known) return known;
    switch (code) {
        case 'invalid_date_range': return t('project_tasks.invalid_date_range', 'The start date must be on or before the due date.');
        case 'SHARED_CHATS_REMAIN': return sharedChatsRemain(t, details);
        case 'KIND_ALREADY_SET': return kindAlreadySet(t, details);
        case 'KIND_HOLDS_OTHER_CONTENT': return kindHoldsOtherContent(t, details);
        case 'KIND_NOT_ALLOWED':
            return t('project_home.errors.kind_not_allowed', 'This cannot be added here. Documents and meeting notes belong in a project; automations, apps and tables belong in a Studio Solution.');
        case 'SOLUTION_HOLDS_NO_CHATS':
            return t('project_home.errors.solution_holds_no_chats', 'This is a Studio Solution, and a Solution holds no chats. Start the chat in a project instead.');
        case 'SOLUTION_HOLDS_NO_FILES':
            return t('project_home.errors.solution_holds_no_files', 'A Studio Solution has no project files. Link a knowledge base to it in Studio instead.');
        case 'PROJECT_KEY_UNAVAILABLE':
            return t('project_home.errors.project_key_unavailable', 'The project’s encryption key is not available right now, so nothing was changed. Try again in a moment.');
        case 'document_read_only':
            return t('project_home.errors.document_read_only', 'You can read this document, but only the project’s editors can change it.');
        case 'document_owner_only':
            return t('project_home.errors.document_owner_only', 'Only the owner of this document can do that. The project owner can remove it from the project.');
        default:
            return message || fallback || t('project_home.errors.generic', 'That did not work. Try again.');
    }
}
