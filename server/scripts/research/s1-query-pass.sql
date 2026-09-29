-- S1 — the Monday query pass
--
-- Five reads against your own instance, before any fix lands. Each one turns a
-- thing a screenshot showed ONCE into a distribution, so the scarce session
-- slots go to the question that actually has a population behind it.
--
-- Run it as the operator, on your own tenant:
--
--     psql "$CORE_DATABASE_URL" -v org=bee-flow -f server/scripts/research/s1-query-pass.sql
--
-- Every query is scoped to one organisation. That is not a nicety: users in a
-- customer tenancy are that customer's data subjects and Bee Flow is their
-- processor, so counting across all tenants to answer a product question is a
-- processor using personal data for its own purposes. Scope it, or do not run
-- it. Nothing here selects message text, document text, titles, or anything a
-- person wrote — only counts, categories and enum values.
--
-- The sixth number, the paying-customer count, is not in this database. Take it
-- from Stripe by hand. It is the ceiling on every recruiting number in the plan,
-- so writing it down first stops the rest of the plan being arithmetic about a
-- population that does not exist.
--
-- ── The kill criterion ──────────────────────────────────────────────────────
-- If any distribution below is under about twenty rows, this instance is not a
-- data source. Counting a population of one is not rigour. Stop, cancel S2, and
-- spend the fortnight on sessions instead.

\set ON_ERROR_STOP on
\timing off

-- The tenancy. Users belong to an organisation through their groups, which are
-- a JSON array on the user row — hence the unnest rather than a join column.
CREATE TEMP VIEW tenant_users AS
SELECT DISTINCT u.id
FROM users u
JOIN groups g ON g."organizationId" = :'org'
WHERE u.groups IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(u.groups::jsonb) AS e(gid)
      WHERE e.gid = g.id
  );

\echo ''
\echo '── 0. Population ───────────────────────────────────────────────────────'
SELECT count(*) AS users_in_tenant FROM tenant_users;

\echo ''
\echo '── 1. Automation runs by status and error class ────────────────────────'
\echo '   Does the Needs-you screen have a population, and is any error class'
\echo '   common enough that fixing its wording would move anything?'
SELECT
    r.status,
    -- Error CLASS, not the error. The first clause up to a colon or a number is
    -- what distinguishes "auth" from "timeout" without quoting anyone's data.
    COALESCE(NULLIF(split_part(split_part(r.error, ':', 1), ' at ', 1), ''), '(none)') AS error_class,
    count(*)                                        AS runs,
    count(*) FILTER (WHERE r.summary IS NOT NULL)   AS with_summary,
    min(r.created_at)::date                         AS first_seen,
    max(r.created_at)::date                         AS last_seen
FROM automation_runs r
JOIN automations a ON a.id = r.automation_id
WHERE a.organization_id = :'org'
GROUP BY 1, 2
ORDER BY runs DESC
LIMIT 40;

\echo ''
\echo '── 2. Conversations by model tier ──────────────────────────────────────'
\echo '   Is the tier control load-bearing, or does everything sit on auto?'
SELECT
    COALESCE(c.model_tier, '(null)') AS model_tier,
    count(*)                         AS conversations,
    count(DISTINCT c.user_id)        AS users,
    max(c.updated_at)::date          AS last_used
FROM direct_conversations c
JOIN tenant_users t ON t.id = c.user_id
GROUP BY 1
ORDER BY conversations DESC;

\echo ''
\echo '── 3. Notifications by category and destination ────────────────────────'
\echo '   The routing bug is three doors to one object landing on three lists.'
\echo '   This says which doors are actually used.'
SELECT
    n.category,
    -- The first path segment of the link, so "/approvals/<id>" and
    -- "/approvals/<other>" count as one destination. Never the id itself.
    COALESCE(NULLIF(split_part(COALESCE(n.link, ''), '/', 2), ''), '(no link)') AS destination,
    count(*)                                 AS notifications,
    count(*) FILTER (WHERE n.read)           AS read,
    round(100.0 * count(*) FILTER (WHERE n.read) / NULLIF(count(*), 0), 1) AS read_pct
FROM notifications n
JOIN tenant_users t ON t.id = n.user_id
GROUP BY 1, 2
ORDER BY notifications DESC
LIMIT 40;

\echo ''
\echo '── 4. Usage by source and client ───────────────────────────────────────'
\echo '   The client column is the Client Ledger. Before it started writing'
\echo '   rows everything reads "unknown" — that is expected, not a bug, and'
\echo '   the share of "unknown" is how you tell how far back the ledger goes.'
SELECT
    COALESCE(l.source, 'unknown')                   AS source,
    COALESCE(l.client, 'unknown')                   AS client,
    count(*)                                        AS calls,
    count(DISTINCT l.user_id)                       AS users,
    count(DISTINCT l.conversation_id)               AS conversations,
    round(sum(l.estimated_cost)::numeric, 2)        AS cost_eur
FROM ai_usage_log l
WHERE l.organization_id = :'org'
  AND l.tool_name IS NULL
  AND l.timestamp > NOW() - INTERVAL '90 days'
GROUP BY 1, 2
ORDER BY calls DESC
LIMIT 40;

\echo ''
\echo '── 4b. The one number S2 turns on ──────────────────────────────────────'
\echo '   Share of interactive turns from the phone. Under 5% after four weeks'
\echo '   of real use and the app should shrink to capture, notify and read.'
SELECT
    COALESCE(client, 'unknown')                                        AS client,
    count(*)                                                           AS turns,
    round(100.0 * count(*) / NULLIF(sum(count(*)) OVER (), 0), 1)      AS pct
FROM ai_usage_log
WHERE organization_id = :'org'
  AND tool_name IS NULL
  AND source IN ('direct_chat', 'agent_chat', 'agent_stream', 'notebook', 'webpage_chat')
  AND timestamp > NOW() - INTERVAL '28 days'
GROUP BY 1
ORDER BY turns DESC;

\echo ''
\echo '── 4c. Recordings by client ────────────────────────────────────────────'
\echo '   S7 asks whether Record earns one of five tabs. A phone that captures'
\echo '   but is never worked in is a different answer from a phone nobody'
\echo '   records on at all, and only this column separates them. Background'
\echo '   ingests (Talk, Meet) have no client and read as unknown.'
SELECT
    COALESCE(t.client, 'unknown')                       AS client,
    COALESCE(t.source, 'upload')                        AS source,
    count(*)                                            AS recordings,
    count(DISTINCT t.user_id)                           AS users,
    round((sum(t.duration_seconds) / 3600.0)::numeric, 1) AS hours
FROM transcriptions t
WHERE t.organization_id = :'org'
GROUP BY 1, 2
ORDER BY recordings DESC;

\echo ''
\echo '── 5. Knowledge bases: made on purpose, or made for you ────────────────'
\echo '   An instance whose KBs are mostly auto-generated is not evidence that'
\echo '   anyone curates a knowledge base. Note: personal KBs carry a NULL'
\echo '   organization_id and are invisible here, deliberately — a personal KB'
\echo '   is not the tenancy\'s data to count.'
SELECT
    COALESCE(kb.source_kind, 'manual')                      AS source_kind,
    count(*)                                                AS knowledge_bases,
    count(*) FILTER (WHERE kb.is_published)                 AS published,
    sum(d.docs)                                             AS documents,
    round(avg(d.docs)::numeric, 1)                          AS avg_docs
FROM knowledge_bases kb
LEFT JOIN LATERAL (
    SELECT count(*) AS docs FROM documents WHERE knowledge_base_id = kb.id
) d ON TRUE
WHERE kb.organization_id = :'org'
GROUP BY 1
ORDER BY knowledge_bases DESC;

\echo ''
\echo '── 6. Thin-distribution check ──────────────────────────────────────────'
\echo '   Anything under 20 fails the kill criterion for that read.'
SELECT 'automation_runs' AS read, count(*) AS rows FROM automation_runs r
    JOIN automations a ON a.id = r.automation_id WHERE a.organization_id = :'org'
UNION ALL
SELECT 'direct_conversations', count(*) FROM direct_conversations c
    JOIN tenant_users t ON t.id = c.user_id
UNION ALL
SELECT 'notifications', count(*) FROM notifications n
    JOIN tenant_users t ON t.id = n.user_id
UNION ALL
SELECT 'ai_usage_log (90d)', count(*) FROM ai_usage_log
    WHERE organization_id = :'org' AND timestamp > NOW() - INTERVAL '90 days'
UNION ALL
SELECT 'transcriptions', count(*) FROM transcriptions WHERE organization_id = :'org'
UNION ALL
SELECT 'knowledge_bases', count(*) FROM knowledge_bases WHERE organization_id = :'org'
ORDER BY rows ASC;

\echo ''
\echo 'Stripe paying customers: ______   (fill this in by hand — it is the'
\echo 'ceiling on every recruiting number in the plan.)'
\echo ''

DROP VIEW tenant_users;
