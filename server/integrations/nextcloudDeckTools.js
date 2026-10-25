// @typecheck strict
/**
 * Nextcloud Deck Tools — kanban boards / stacks / cards / labels / comments.
 *
 * Uses the Deck app's REST API at /index.php/apps/deck/api/v1.0/. Auth handled
 * by ./nextcloudClient (Bearer when the user logged in via Nextcloud OAuth,
 * app-password Basic otherwise).
 *
 * Coverage: list boards, list stacks, list/search cards, get card, create card,
 * update card (title/desc/duedate/labels), move card across stacks, archive,
 * delete, and add comments.
 */

const ncClient = require('./nextcloudClient');
const { HANDLERS, deckRoot } = require('./nextcloudDeckHandlers');

const NEXTCLOUD_DECK_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_boards',
            description: 'List Deck boards the user has access to. Returns id, title, color, archived state, and label/permission summary.',
            parameters: {
                type: 'object',
                properties: {
                    includeArchived: { type: 'boolean', description: 'Include archived boards (default false).' }
                }
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_get_board',
            description: 'Fetch a single Deck board with its full label set, ACL, and stack/card counts.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer', description: 'Numeric board id (from list_boards).' }
                },
                required: ['boardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_stacks',
            description: 'List the columns ("stacks") of a Deck board. Each stack carries the cards currently in that column.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' }
                },
                required: ['boardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_create_stack',
            description: 'Create a new column ("stack") on a Deck board. Use this to set up board structure (e.g. "New", "In Progress", "Done") before adding cards. The user has approved this — go ahead.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer', description: 'Board id from nextcloud_deck_list_boards.' },
                    title: { type: 'string', description: 'Column title (e.g. "In Wait", "To Verify").' },
                    order: { type: 'integer', description: 'Optional sort order. Lower numbers appear first; defaults to 999 (rightmost).' }
                },
                required: ['boardId', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_update_stack',
            description: 'Rename a stack or change its order. Only provided fields change. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    title: { type: 'string' },
                    order: { type: 'integer' }
                },
                required: ['boardId', 'stackId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_delete_stack',
            description: 'Delete a stack (column) from a Deck board. This also removes the stack\'s cards. Always confirm with the user before calling — Deck keeps a deleted stack in its deleted items, but this API cannot restore it.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' }
                },
                required: ['boardId', 'stackId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_cards',
            description: 'List cards on a board, optionally filtered by stack, label, due date, or assigned user. Combine multiple filters to narrow the result.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer', description: 'Filter to a single stack.' },
                    labelTitle: { type: 'string', description: 'Filter to cards carrying a label whose title matches (case-insensitive).' },
                    assignedUid: { type: 'string', description: 'Filter to cards assigned to a specific Nextcloud user.' },
                    dueBefore: { type: 'string', description: 'ISO 8601 — keep only cards with duedate <= this.' },
                    dueAfter: { type: 'string', description: 'ISO 8601 — keep only cards with duedate >= this.' },
                    includeArchived: { type: 'boolean' },
                    limit: { type: 'integer', description: 'Max cards (default 200, max 1000).' }
                },
                required: ['boardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_search_cards',
            description: 'Search cards on a board by case-insensitive substring match against title and description.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    query: { type: 'string' },
                    limit: { type: 'integer', description: 'Max results (default 50, max 200).' }
                },
                required: ['boardId', 'query']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_get_card',
            description: 'Fetch a single Deck card with full description, labels, assigned users, comments, and attachments.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_create_card',
            description: 'Create a new Deck card. The user has approved this — go ahead and create it. Use list_boards / list_stacks first if you need ids.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer', description: 'Column the card lands in.' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    duedate: { type: 'string', description: 'ISO 8601 due date (optional).' },
                    type: { type: 'string', description: 'Card type, defaults to "plain".' }
                },
                required: ['boardId', 'stackId', 'title']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_update_card',
            description: 'Update fields on a Deck card. Only provided fields change. Pass `targetStackId` to move the card between columns. The user has approved this update.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer', description: 'Current stack the card lives in.' },
                    cardId: { type: 'integer' },
                    title: { type: 'string' },
                    description: { type: 'string' },
                    duedate: { type: 'string', description: 'ISO 8601, or empty string to clear.' },
                    targetStackId: { type: 'integer', description: 'If set, move the card to this stack on the same board.' },
                    order: { type: 'integer', description: 'Position within the (target) stack. 0 = top.' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_archive_card',
            description: 'Archive (or unarchive) a Deck card. Confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' },
                    archived: { type: 'boolean', description: 'true = archive, false = unarchive (default true).' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_delete_card',
            description: 'Delete a Deck card permanently. Always confirm with the user before calling.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_assign_label',
            description: 'Attach a label (by id) to a card. Get label ids via get_board.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' },
                    labelId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId', 'labelId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_remove_label',
            description: 'Detach a label from a card.',
            parameters: {
                type: 'object',
                properties: {
                    boardId: { type: 'integer' },
                    stackId: { type: 'integer' },
                    cardId: { type: 'integer' },
                    labelId: { type: 'integer' }
                },
                required: ['boardId', 'stackId', 'cardId', 'labelId']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_add_comment',
            description: 'Add a comment to a Deck card.',
            parameters: {
                type: 'object',
                properties: {
                    cardId: { type: 'integer' },
                    message: { type: 'string', description: 'Plain-text comment body.' },
                    parentId: { type: 'integer', description: 'Optional parent comment id (reply).' }
                },
                required: ['cardId', 'message']
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'nextcloud_deck_list_comments',
            description: 'List comments on a Deck card (newest first).',
            parameters: {
                type: 'object',
                properties: {
                    cardId: { type: 'integer' },
                    limit: { type: 'integer', description: 'Max comments (default 50, max 200).' }
                },
                required: ['cardId']
            }
        }
    }
];

// ─── Tool execution ──────────────────────────────────────────────

/**
 * @param {string} toolName
 * @param {import('./nextcloudDeckHandlers').DeckArgs} args
 * @param {string} userId
 * @param {Partial<Express.Session>} session
 */
async function executeNextcloudDeckTool(toolName, args, userId, session) {
    // Deck's REST controllers (BoardApiController, StackApiController, etc.)
    // are #[CORS]-annotated, so Nextcloud's CORS middleware rejects OAuth
    // Bearer auth (logs the session out, demands HTTP Basic). Prefer the
    // user's app password when available; fall back to OAuth only for
    // environments where Bearer happens to work (some older NC versions).
    // ...except for connector sessions: those authenticate with AppAPI
    // shared-secret impersonation, not a Bearer session, so the CORS middleware
    // never fires. Reaching for an app password there would route the call
    // outside the connector — a different base URL, a weaker SSRF posture, and
    // the user's credentials on the wire — purely because they happened to have
    // one saved.
    let ctx = null;
    if (ncClient.isConnectorSession(session)) {
        ctx = await ncClient.resolveAuth(session, userId);
    } else {
        ctx = await ncClient.resolveBasicAuthOrNull(userId);
        if (!ctx) {
            if (ncClient.isNextcloudOAuthSession(session)) {
                return { error: ncClient.CORS_AUTH_ERROR };
            }
            ctx = await ncClient.resolveAuth(session, userId);
        }
    }
    const { baseUrl, fetch: ncFetch, authError } = ctx;
    const api = deckRoot(baseUrl);

    const handler = Object.hasOwn(HANDLERS, toolName) ? HANDLERS[toolName] : null;
    if (!handler) return { error: `Unknown Nextcloud Deck tool: ${toolName}` };
    return handler(args, { api, ncFetch, authError, baseUrl, toolName });
}

/** @param {unknown} toolName */
function isNextcloudDeckTool(toolName) {
    return typeof toolName === 'string' && toolName.startsWith('nextcloud_deck_');
}

module.exports = {
    NEXTCLOUD_DECK_TOOLS,
    executeNextcloudDeckTool,
    isNextcloudDeckTool,
};
