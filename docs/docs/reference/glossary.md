---
title: Glossary
---

# Glossary

| Term | Meaning |
|------|---------|
| **Action item** | A discrete task extracted from a conversation / transcript. |
| **Agent** | A configured AI persona with a name, system prompt, model, tool selection, KB list, and visibility. |
| **AppAPI** | Nextcloud's app system for ExApps. Handles install, lifecycle, signed proxy. |
| **Audit log** | The persistent record of guardrail events + admin actions. Stored in Postgres, queryable in **Admin → Audit**. |
| **Automation** | A trigger-driven workflow that runs steps (AI / tool / code / approval / condition / loop). |
| **Backstop** | The 6-hourly cron that re-syncs NC users / groups in case webhook events were missed. |
| **bge-m3** | The default multilingual embedding model used by Knowledge Bases. 1024-dim. |
| **Bootstrap** | The first-install flow on the connector that provisions a tenant key against the Bee Flow service. |
| **BSN** | Burgerservicenummer — the Dutch national ID number. Built-in PII category. |
| **Citation** | A reference to a KB source in a model's reply, rendered either inline or as a card. |
| **Community tier** | Free tier. Single user, 2 agents, 1 000 messages / month. |
| **Component** | An AI-built sandboxed UI fragment that an agent can emit instead of plain Markdown. |
| **Connector** | The Bee Flow Nextcloud ExApp. Container at `ghcr.io/bee-flow/connector`, AGPL-3.0. |
| **Conversation** | A chat thread between a user and an agent, persisted in Postgres. |
| **DSR** | Data Subject Request — GDPR term for a user requesting access, portability, or erasure of their data. |
| **Embedding** | A high-dimensional vector representation of text used for similarity search. |
| **Enterprise tier** | Includes GDPR compliance hub, SAML SSO, audit log export, unlimited users / agents / messages. |
| **ExApp** | Nextcloud "External App" — a Docker container that integrates with NC via AppAPI. |
| **Fair-code** | Source-available licensing that permits self-hosting + modification but restricts third-party SaaS resale. SUL is fair-code. |
| **Full tier** | Top tier: Enterprise + white-label + sub-licence issuance. |
| **Guardrail** | A check the server performs on prompts / tool results — PII, custom term, moderation, unicode-smuggling. |
| **HaRP** | Nextcloud's "Hostname/Reverse Proxy" deployment daemon for ExApps. |
| **Hive** | The frontend repo (`Bee-Flow/hive`). React + Vite SPA. |
| **HMAC** | Keyed hash used to sign requests between connector and Bee Flow service (SHA-256). |
| **Idempotency key** | A client-supplied UUID on POST that lets the server cache the first response and replay it on duplicates. |
| **Integration** | A connector to an external service (Gmail, Outlook, GitHub, …). Each exposes one or more tools. |
| **JWT** | JSON Web Token. Used for sessions, NC handshakes, and licence keys. |
| **Knowledge Base (KB)** | A document collection the agent can search. Local (Postgres) or vector (pgvector / Qdrant). |
| **Licence key** | A signed JWT that unlocks the paid tiers. Verified against the Bee Flow licence server's public key (`LICENSE_PUBLIC_KEY`, `LICENSE_PUBLIC_KEY_FILE` or `LICENSE_JWKS_URL`). |
| **Memory** | Per-user (or per-agent) facts the **Memory Extractor** system agent populates over time. |
| **Moderation** | Post-generation safety check via Azure Content Safety. |
| **NC** | Nextcloud. |
| **OCS** | Open Collaboration Services — Nextcloud's REST API style for non-DAV endpoints. |
| **Org / Organisation / Tenant** | A self-contained Bee Flow workspace. Has users, groups, agents, settings, licence. |
| **PGVector** | Postgres extension providing native vector similarity search. Used for KBs in default deploys. |
| **PII** | Personally Identifiable Information — what the Privacy Shield detects + redacts. |
| **Pro tier** | A retired paid tier. Keys that still carry `tier: "pro"` resolve to Enterprise. |
| **Privacy Shield** | The in-tenant PII filter that redacts sensitive content before it reaches the model. Always-on; level configurable. |
| **Reranker** | A cross-encoder that re-orders top-K KB search results for better quality. Optional. |
| **Routine** | The end-user name for an automation in the SPA (`/app/routines`). |
| **RRF** | Reciprocal Rank Fusion — combines vector + BM25 search results into a single ranked list. |
| **Skill** | A reusable bundle (prompt extension + tools + KB) attachable to any agent. Pro+ feature. |
| **SSE** | Server-Sent Events. The streaming protocol for chat replies. |
| **SUL** | Sustainable Use Licence — Bee Flow's fair-code licence for the server + frontend. |
| **System agent** | One of 10 built-in agents seeded by the system (Title Generator, Memory Extractor, etc.). |
| **Template** | A pre-built agent recipe (prompt + tools + KB). Cloning produces an editable agent. |
| **Tenant key** | The HMAC secret bound to an org's connector pairing. Stored in connector cache + Bee Flow DB. |
| **Tool** | A typed function the agent's model can call (`gmail_search`, `nextcloud_files_read`, …). |
| **Tool call** | A specific invocation of a tool by the model in a turn. Streamed as `tool_call` SSE events. |
| **VAD** | Voice Activity Detection. Energy-based with hysteresis; tunes when "user is speaking". |
| **Voxtral** | The default voice provider (STT + TTS). Multilingual. |
| **Wizard** | The 4-step first-run admin onboarding flow. |
