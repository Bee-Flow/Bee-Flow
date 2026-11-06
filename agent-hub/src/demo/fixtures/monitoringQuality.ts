/**
 * Quality tab fixtures of the Usage & Monitoring demo.
 */

const dayKey = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/* ── Quality: feedback and terminations ───────────────────────────────
   The exact wire shape of GET /api/feedback/org[/summary] and
   GET /api/terminations/org[/summary|/timeline|/by-agent]: 14 ratings
   (11 up, 3 down, 4 with a comment, 2 with a shared conversation) and
   6 terminations (3 max tokens, 1 max iterations, 2 errors). */

/* People: pseudonymous by default, the label the Adoption demo uses for the same person; the
   reveal (`reveal=true`) answers the display name instead. Anonymous rows carry no person. */
const PERSON_ID = 'user-k7q2';
const personOf = (reveal: boolean, userId: string | null) => {
    if (!userId) return null;
    return reveal ? { id: userId, name: 'Noor Bakker' } : { id: '9c1d4e7a2b6f3085', name: 'Member · K7Q2' };
};
const revealed = (ctx: { query?: URLSearchParams }) => ctx.query?.get('reveal') === 'true';

const ts = (daysAgo: number, hour: number) => `${dayKey(daysAgo)}T${String(hour).padStart(2, '0')}:00:00.000Z`;

const SNAPSHOT = JSON.stringify([
    { role: 'user', content: 'Summarise the meeting and list the action items.' },
    { role: 'assistant', content: 'The team agreed on the launch date. Open items: **pricing page copy**.', model: 'claude-sonnet-5', duration_ms: 2300 },
]);

const rated = (id: string, rating: 'up' | 'down', daysAgo: number, extra: Record<string, unknown> = {}) => ({
    id: `fb-${id}`,
    rating,
    conversation_id: `conv-${id}`,
    message_id: `msg-${id}`,
    agent_id: 'direct',
    agent_name: null,
    user_id: PERSON_ID,
    source: 'direct',
    model: 'claude-sonnet-5',
    model_tier: null,
    comment: null,
    conversation_snapshot: null,
    created_at: ts(daysAgo, 14),
    ...extra,
});

const FEEDBACK_ITEMS = (reveal: boolean) => ([
    rated('1', 'down', 1, { comment: 'The summary skipped the action items from the last ten minutes of the meeting.', conversation_snapshot: SNAPSHOT }),
    rated('2', 'down', 3, { comment: 'Answered in English although I asked in Dutch.', model: 'claude-haiku-5-5' }),
    rated('3', 'up', 4, { comment: 'Exactly the table I needed, first try.', source: 'automation', model: 'claude-haiku-5-5', conversation_snapshot: SNAPSHOT }),
    rated('4', 'down', 8, { user_id: null }), // anonymous
    rated('5', 'up', 14, { comment: 'Good catch on the missing invoice number.', source: 'app_studio', agent_name: 'Invoice Basics' }),
    ...[6, 7, 8, 9, 10, 11, 12, 13, 14].map((n, i) => rated(String(n), 'up', 16 + i)),
]).map(({ user_id, ...row }) => ({ ...row, person: personOf(reveal, user_id as string | null) }));

const FEEDBACK_SUMMARY = () => ({ total: 14, thumbs_up: 11, thumbs_down: 3, with_comments: 4 });

const termination = (id: string, daysAgo: number, type: string, extra: Record<string, unknown> = {}) => ({
    id: `term-${id}`,
    timestamp: ts(daysAgo, 10),
    termination_type: type,
    source: 'chat',
    conversation_id: `conv-t${id}`,
    user_id: PERSON_ID,
    agent_id: 'direct',
    agent_name: 'Direct chat',
    model: 'claude-sonnet-5',
    error_code: null,
    error_class: null,
    error_first_line: null,
    stack_first_line: null,
    iteration_count: 3,
    duration_ms: 18_400,
    attachment_count: 0,
    attachment_bytes: 0,
    prompt_tokens: 2_400,
    completion_tokens: 4_096,
    total_tokens: 6_496,
    ...extra,
});

const BIG_PROMPT = { prompt_tokens: 61_000, completion_tokens: 900, total_tokens: 61_900 };

const TERMINATION_ROWS = (reveal: boolean) => ([
    termination('1', 1, 'max_tokens', { agent_id: 'studio', agent_name: 'App Studio assistant', ...BIG_PROMPT }),
    termination('2', 2, 'max_tokens', { agent_id: 'studio', agent_name: 'App Studio assistant', ...BIG_PROMPT }),
    termination('3', 5, 'max_iterations', { agent_id: 'studio', agent_name: 'App Studio assistant', iteration_count: 25 }),
    termination('4', 6, 'max_tokens'),
    termination('5', 9, 'error', { error_code: 'rate_limited', error_class: 'ProviderError', error_first_line: 'Too many requests' }),
    termination('6', 12, 'error', { agent_id: 'auto', agent_name: 'Weekly report', source: 'automation', error_code: 'timeout', error_class: 'TimeoutError', error_first_line: 'upstream timed out' }),
]).map(({ user_id, ...row }) => ({ ...row, person: personOf(reveal, user_id as string | null) }));

const TERMINATION_SUMMARY = () => ({ total: 6, by_type: { max_tokens: 3, max_iterations: 1, error: 2, aborted: 0 } });

const TERMINATION_TIMELINE = () => ([
    { period: dayKey(12), termination_type: 'error', count: 1 },
    { period: dayKey(9), termination_type: 'error', count: 1 },
    { period: dayKey(6), termination_type: 'max_tokens', count: 1 },
    { period: dayKey(5), termination_type: 'max_iterations', count: 1 },
    { period: dayKey(2), termination_type: 'max_tokens', count: 1 },
    { period: dayKey(1), termination_type: 'max_tokens', count: 1 },
]);

const TERMINATION_BY_AGENT = () => ([
    { agent_id: 'studio', agent_name: 'App Studio assistant', total: 3, max_tokens: 2, max_iterations: 1, errors: 0, aborted: 0 },
    { agent_id: 'direct', agent_name: 'Direct chat', total: 2, max_tokens: 1, max_iterations: 0, errors: 1, aborted: 0 },
    { agent_id: 'auto', agent_name: 'Weekly report', total: 1, max_tokens: 0, max_iterations: 0, errors: 1, aborted: 0 },
]);

export const QUALITY_ROUTES = {
    'GET /api/feedback/org': (ctx: { query?: URLSearchParams }) => FEEDBACK_ITEMS(revealed(ctx)),
    'GET /api/feedback/org/summary': () => FEEDBACK_SUMMARY(),
    'GET /api/terminations/org': (ctx: { query?: URLSearchParams }) => ({ rows: TERMINATION_ROWS(revealed(ctx)), revealed: revealed(ctx) }),
    'GET /api/terminations/org/summary': () => TERMINATION_SUMMARY(),
    'GET /api/terminations/org/timeline': () => ({ rows: TERMINATION_TIMELINE(), interval: 'day' }),
    'GET /api/terminations/org/by-agent': () => ({ rows: TERMINATION_BY_AGENT() }),
};
