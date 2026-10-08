---
title: Azure SSO release upgrade
---

# Azure SSO release: upgrade and acceptance

This release changes Microsoft account matching, Azure group synchronization and OAuth secret storage. Existing user IDs, conversations, group IDs and explicitly authorized organization memberships remain in place. Do not run old and new server replicas together during migration: older versions read plaintext OAuth metadata.

## Before the maintenance window

1. Build a production candidate from `main` with `Build & Push`, including `server`, `agent-hub` and `connector` when Nextcloud is deployed. Record the `release-candidate.json` artifact and every immutable image digest. Builds publish candidate tags; production tags move only through `Promote validated release`.
   The manifest contains the selected images. For an installation with optional services, record their currently running immutable digests too. Apply new images through a per-service Compose override and retain the existing digest pins for unchanged services. Do not set a new shared `TAG` unless that tag exists for every enabled service; a core-only candidate does not publish new tags for unchanged optional services.
2. Test both a restored copy of an existing installation and a clean installation on staging. Keep production credentials and customer data out of test reports. Retain evidence of the migration, login, sync, secret rotation and backup restoration checks described below.
3. Verify that an active **local platform administrator** can sign in without Microsoft SSO. This is required only as a safety net: installations using `common`, duplicate legacy object IDs or an administrator who never logged in through Microsoft before may need one manual approval. Test the recovery account before stopping the old release; an unverified legacy Microsoft administrator cannot approve its own identity after the upgrade.
4. Back up all databases used by the installation and verify restoration. Retain the matching `MASTER_ENCRYPTION_KEY`, deployment settings and previous immutable image digests securely. Do not rotate the master key during this upgrade.
5. Verify that the candidate receives `CORE_DATABASE_URL` for the **same existing core database**, `SESSION_SECRET` and the retained `MASTER_ENCRYPTION_KEY`. The production server refuses a missing core URL. A deployment that previously relied on the development default must explicitly configure its existing database URL; do not point an upgrade at a new empty database. Preserve any separate tenant/business and monitoring database settings.
6. Confirm the concrete Microsoft tenant GUID in **Security → SSO**. `common`, `organizations` and `consumers` are login policies, not sync tenant IDs. With a concrete tenant and exactly one organization that has Azure sync settings or Azure groups, the migration binds that organization automatically. With several candidate organizations, or with `common`, nothing is selected and a platform administrator must choose.
7. Ensure the production and staging Docker Engine are **29.5.1 or newer**. Verify the daemon with `docker version --format '{{.Server.Version}}'`, including any remote daemon used through the Docker socket. A patched CLI does not patch its host daemon.

Inspect the old database using the candidate's code and the same database connection settings. The default inspector is read-only, handles the old schema and does not start the application:

```sh
cd server
node scripts/microsoft-sso-upgrade.js > microsoft-upgrade-preview.json
```

Use Node `22.23.2` and the candidate lockfile. In a container deployment, run this command in a one-off candidate container with the existing private environment configuration and database network; override its entrypoint to `node` and pass `scripts/microsoft-sso-upgrade.js`. Do not start the candidate server against the old installation just to generate this report. Do not put credentials in shell command arguments or publish the report without checking its account and organization IDs.

The preview reports identities to be linked (`verified`, with `basis`) and unresolved identities, duplicate object IDs, organizations, the automatic sync binding (`autoBinding`) or the ambiguous candidates (`syncBindingAmbiguous`), Azure groups, plaintext credential presence and timers that lack an authorized binding. It may contact Microsoft Graph read-only. With a configured concrete tenant, a stored object ID that is unique is linked to that tenant; if Graph confirms the object it is `directory_verified`, if Graph is unreachable or the app lacks permission it is `configured_tenant` (the object ID was written by an earlier login or sync against that one directory). A directory that answers that the object does not exist blocks the link. With `common`, `organizations` or `consumers`, nothing is linked by the migration. Resolve complete duplicate identity pairs before applying schema changes; the unique index deliberately refuses conflicting complete links.

## Apply the upgrade

1. Put the installation into maintenance mode and stop **all old server replicas**, background workers that run Azure sync, and automatic restarts of the old release. Keep database and storage services available. Take the final consistent database backup.
2. Run the full migration runner from the candidate image with the installation's existing environment and database network:

   ```sh
   cd server
   npm run db:migrate
   ```

   Require exit code zero and review the migration report. This awaits schema creation and the registered boot migrations. It performs transactional OAuth secret migration, verifies encrypted readback, then removes secrets from ordinary metadata. A decryption, database or conflict error blocks the upgrade; do not replace the master key or manually restore plaintext metadata to bypass it. The dedicated `node scripts/microsoft-sso-upgrade.js --apply` command is available for explicitly repeating the Microsoft migration after configuration corrections; it is not a replacement for the full migration runner.
3. Start the new server and frontend from the recorded candidate digests. Check health and startup/migration logs before restoring traffic. Repeating `npm run db:migrate` must succeed without changing existing account, conversation or group IDs.
4. Sign in with the local platform administrator. In **Security → SSO**, check the Microsoft sync organization and tenant: for a single-organization installation on a concrete tenant the migration has already bound it and periodic sync resumes by itself (the migration log says so). Only platform administrators may change this binding. If it shows as unbound (several organizations, or `common`), choose the organization; until then legacy periodic timers stay disabled. Attempts from another organization return `403`.
5. Existing Microsoft users sign in again once: pre-upgrade Microsoft SSO sessions and handoff tokens are rejected by the new version (this is expected). Microsoft mailbox/integration credentials are retained. On a concrete tenant no administrator action is needed. The first login links the old account automatically when (a) the stored object ID matches the verified ID token of the configured tenant, or (b) the account has no object ID, exactly one local account has the token's e-mail address, and that account is not a platform administrator (the previous behaviour); both are recorded in the binding audit (actor `migration`, `auto-link-oid` or `auto-link-email`). Ambiguous cases return `sso_link_required`, create no account session and record a token-free request valid for seven days: `common`/`organizations`/`consumers`, duplicate object IDs or e-mail addresses, an object ID or account bound to another identity, and platform administrators without a stored object ID.
   A Microsoft user without an account yet (a new employee) is placed by the verified tenant of the ID token, never by e-mail domain: in the organization of the Azure sync binding for that tenant, or, without a binding, in the only organization of the installation when the token comes from the configured concrete tenant. The organization's auto-approve setting and seat limit still apply; any other case leaves the account without an organization for an administrator to place.
6. Review each pending request against the intended local account and confirm it using the platform administrator's link action. Expired requests require a fresh Microsoft login. Conflicting links return `409`; linking an already linked account requires explicit unlinking first. Review the binding audit records. Unlinking invalidates prior Microsoft cookie and bridge sessions, even when the same identity is subsequently linked again. A Microsoft login remains subject to this check after connecting or disconnecting a mailbox integration; locally authenticated sessions with integration credentials are preserved.
7. Run a manual sync. Verify that users already authorized in the target organization receive the expected memberships, users belonging only to another organization are skipped, and existing explicit membership in multiple organizations still works. Existing verified Azure group IDs are retained. Manual memberships are preserved; destructive sync can remove only memberships with sync provenance. Partial Graph reads or provisioning failures prevent cleanup.
8. Rotate each OAuth provider secret independently and verify Microsoft, Google and Nextcloud login. An empty or omitted secret field retains its current value. Check that ordinary metadata and API responses contain only credential-presence indicators.

For a clean installation, run the normal setup with the same candidate versions. Confirm a local administrator and the explicit directory binding before enabling timers. No legacy account or secret migration is needed, but the same release acceptance checks apply.

## Staging acceptance and promotion

`Validate release candidate on staging` accepts a successful candidate workflow run ID and a reviewed JSON acceptance record. The workflow validates the candidate commit, run attempt and exact deployed image digests. It makes real Azure calls for Responses, streaming, a forced function call, embeddings, Document Intelligence and speech. Missing settings or a failed capability blocks acceptance.

Configure these staging environment variables: `STAGING_BASE_URL`, `AZURE_OPENAI_ENDPOINT`, `AZURE_RESPONSES_DEPLOYMENT`, `AZURE_EMBEDDINGS_DEPLOYMENT`, `AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT` and `AZURE_SPEECH_REGION`. Configure the matching secrets: `AZURE_OPENAI_KEY`, `AZURE_DOCUMENT_INTELLIGENCE_KEY` and `AZURE_SPEECH_KEY`. The staged server's `/api/health` must report the candidate commit in `appVersion`.

The manual record must include an HTTPS `evidenceUrl`, the exact `images` object from `release-candidate.json`, and these reviewed booleans in `checks`:

- `existingInstallationUpgrade` and `cleanInstallation`: both installation paths have been exercised.
- `microsoftLogin`, `administratorLink` and `unauthorizedLinkRefused`: identity and administrator authorization checks passed, including expired/conflicting requests.
- `organizationSyncIsolation` and `explicitMultiOrganizationMembership`: sync stays inside the confirmed binding and preserves explicit memberships.
- `secretRotation`, `migrationRepeatability` and `backupRestore`: rotation, repeated migration and restoration passed with the retained master key.
- `dockerHostPatched`: the actual deployment daemon meets the minimum above.
- `nextcloudHarpCompatibility`: the rebuilt FRP `0.61.1` client, HTTP proxy and WebSocket paths work against the deployed Nextcloud/HaRP configuration. When Nextcloud is not deployed, record that fact in the evidence before marking the check complete.
- `applicationAzureModelCalls`: exercise the staged application's configured Azure providers, including Responses/streaming/tool calls, embeddings, document analysis and speech. Record application evidence in addition to the workflow's direct SDK probes.

`azureLiveRequests` is set only after the workflow's real Azure smoke test succeeds. The workflow records the reviewer and time; acceptance expires after seven days and must match the candidate run attempt. `Promote validated release` rechecks workflow provenance, candidate lockfiles, current dependency reachability reviews and current immutable container scans before the protected production job can change tags. It promotes the existing images without rebuilding them.

High/critical findings require an explicit, dated, unexpired reachability review. Container reviews are scoped by service, package/version and relevant code path. Reviews that rely on absent programs, a non-root user or removed SUID/SGID bits also require `scripts/check-release-container.sh` to pass against the same immutable digest. Container package counts and older audit baselines alone do not approve a release. The temporary Debian/tooling reviews expire on **2026-11-08** and must be revisited before any later promotion.

Docker Hub mirrors require the published production release evidence and repeat scans before writes. The public Nextcloud mirror carries the approved connector digest and repeats the gates; it promotes that image instead of rebuilding production from a tag. Configure the mirroring GitHub App with workflow-write permission when updating the carried release workflow.

## Rollback

Stop the new replicas, restore the corresponding database backup and matching master key/configuration, and restore the previous immutable images. Keep Microsoft SSO and Azure group sync disabled until the safe release is restored. A database rollback can restore insecure legacy identity decisions, so merely changing the image tag is insufficient.

Before enabling traffic on an old image, disable Microsoft login in its restored SSO configuration, disable all Azure periodic sync configurations, and revoke its Microsoft **login** sessions and associated Redis bridge/pickup records through the installation's session maintenance procedure. Preserve mailbox/integration credential storage. Never re-enable the old Microsoft login or sync implementation as a recovery shortcut. A local platform administrator supplies access during recovery.

## Review groups

Review these changes as three units, each with its regression coverage:

1. Configuration/secret migration: `authConfigStore`, `configEncryption`, awaited configuration callers and transactional migration tests.
2. Identity/group sync: verified ID tokens, tenant/object identity, administrator binding API/UI, scoped membership provenance, upgrade inspector and regressions for existing installations.
3. Dependencies/release gates: lockfiles and Node versions, export/proxy tests, immutable candidate/staging/promotion/mirror workflows and security gate refusal tests.

Installation scripts and encryption-backfill changes maintained in the other development session must be reviewed and validated together with this release. A failing full suite, lint/typecheck, build, secrets scan or security gate blocks production even when the targeted Azure regressions pass.
