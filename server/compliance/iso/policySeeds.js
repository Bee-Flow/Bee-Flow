/**
 * ISMS policy seeds — starting points, not finished policies. First publish
 * copies the seed into the org's own document row; the UI nudges until the
 * org has actually edited it (auditors spot unedited templates instantly).
 * All text is original to Bee Flow. Structural inspiration: strongDM Comply
 * (Apache-2.0). Controls listed per policy are the Annex A controls the
 * document primarily evidences.
 *
 * Placeholders: "{org}" = organisation name, "{owner}" = document owner.
 * Square brackets mark values the org must fill in with its own numbers.
 */
const POLICY_SEEDS = [
    {
        slug: 'information-security-policy',
        title: 'Information Security Policy',
        controls: ['A.5.1'],
        reviewMonths: 12,
        body: `# Information Security Policy

## Purpose

This policy is the top document of the information security programme at {org}. It states what we protect, why we protect it, and who is responsible for that. Every other policy in this library builds on it. Our goal is simple: keep the information that customers, colleagues, and partners trust us with confidential, correct, and available.

## Scope

This policy applies to everyone who works for or with {org}: employees, contractors, interns, and temporary staff. It covers all information we process, in every form — in the Bee Flow workspace, in other cloud services, on laptops and phones, and on paper. It also covers the AI assistants, automations, and knowledge bases we run, because prompts, transcripts, and model outputs are information too.

## Policy

- Leadership owns security. Management approves this policy, funds the security programme, and reviews its results at least once a year.
- We protect three things: confidentiality (only the right people see information), integrity (information is correct and complete), and availability (information is there when we need it).
- We work risk-based. The Risk Management Methodology describes how we find, score, and treat risks. A control exists because a risk justifies it, not because a checklist mentions it.
- Every policy in this library has an owner, a review date, and a version history in the Compliance Hub. A policy past its review date is treated as a finding, not a formality.
- We set measurable security objectives each year and track them in the Compliance Hub.
- Everyone reports security problems through the channel in the Incident Response Policy. Reporting an honest mistake is never punished.
- Breaking these policies on purpose can lead to disciplinary measures, up to ending the contract or engagement.
- Where we promise customers zero-knowledge encryption, no process or shortcut may undermine that promise. Changes that touch encryption or access control always go through review.

## Roles & responsibilities

- Management team: approves this policy, provides budget and people, and carries final responsibility for security.
- ISMS lead: runs the security programme day to day, maintains this policy library, and reports progress and incidents to management. Current holder: {owner}.
- Data Protection Officer (DPO) or privacy contact: watches GDPR compliance, advises on personal data questions, and is the contact point for authorities and data subjects.
- Team leads: make sure their teams know and follow these policies.
- Everyone: follows the policies, completes training, and reports incidents.

If one person fills more than one of these roles, record that here and explain how conflicts of interest are avoided.

## Review

The ISMS lead ({owner}) reviews this policy at least every 12 months, and earlier after a serious incident, a change in the organisation, or a change in the law. Management approves each new version. Review dates and approvals are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'acceptable-use',
        title: 'Acceptable Use Policy',
        controls: ['A.5.10', 'A.6.2'],
        reviewMonths: 12,
        body: `# Acceptable Use Policy

## Purpose

This policy sets the rules for using the devices, accounts, information, and AI tools of {org}. Clear rules protect the organisation and protect you: if you work within them, you are on safe ground.

## Scope

This policy applies to everyone with a {org} account or device: employees, contractors, interns, and temporary staff. It covers laptops, phones, company accounts, the Bee Flow workspace (chat, agents, automations, notebooks, knowledge bases), and every other service {org} provides — in the office, at home, and on the road.

## Policy

General use:

- Use company accounts and devices for work. Limited personal use is fine as long as it is legal, does not get in the way of your work, and creates no security risk.
- Lock your screen when you step away. Keep the operating system and browser up to date, and leave disk encryption switched on.
- Sign in only with your own account. Never share passwords or session tokens, and never work under someone else's account.
- Install software from trusted sources only. If a tool will process company data, ask the ISMS lead before you start using it.

Information handling:

- Handle information according to its classification level (see the Asset Management Policy).
- Keep company data in approved systems. Do not copy confidential or personal data to private email, private cloud storage, or USB sticks.

AI tools:

- Use the AI assistants and automations that {org} provides in Bee Flow. They run in our own environment, with the Privacy Shield (DLP and PII guardrails) active.
- Do not enter confidential or personal data into external AI tools that {org} has not approved.
- Review AI output before you act on it or share it. You stay responsible for the result — the model does not.
- Do not try to bypass the Privacy Shield, redaction rules, or any other guardrail.

Never allowed:

- Illegal activity, harassment, or content that breaks our code of conduct.
- Disabling, bypassing, or testing security controls without written permission from the ISMS lead.

Monitoring notice:

- {org} logs security-relevant events: sign-ins, admin actions, sharing, and guardrail hits. We log to protect systems and data, not to watch individuals. What is logged, for how long, and who can see it is described in the Logging & Monitoring Policy, and access to logs is restricted.

## Roles & responsibilities

- Everyone: follows these rules and asks the ISMS lead when unsure — asking first is always the right move.
- ISMS lead: approves tools, answers questions, and keeps this policy current.
- Team leads: make sure new team members read this policy in their first week.
- IT/admins: enforce technical settings (screen lock, encryption, updates) where possible, so the rules do not depend on memory alone.

## Review

The policy owner ({owner}) reviews this policy at least every 12 months, and earlier when {org} adopts new tools or new ways of working. Material changes are announced to all staff. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'access-control',
        title: 'Access Control Policy',
        controls: ['A.5.15', 'A.5.16', 'A.5.18', 'A.8.2', 'A.8.3'],
        reviewMonths: 12,
        body: `# Access Control Policy

## Purpose

This policy explains how {org} decides who gets access to what, how access is granted and taken away, and how we check that reality still matches the plan. The core idea is least privilege: enough access to do your job, and nothing more.

## Scope

All systems and information of {org}: the Bee Flow workspace, cloud services, infrastructure, code repositories, and internal admin tools. It applies to human accounts and to machine identities (service accounts, API keys, and agent identities).

## Policy

Principles:

- Least privilege: you get the access your role needs, and nothing more.
- Need to know: confidential information is shared with the people who need it for their work, not with everyone who might be curious.
- Access is granted through roles and groups, not through one-off personal grants. In Bee Flow, access follows the role model in Users & Groups. Exceptions are documented with a reason and an expiry date.
- Every account belongs to one named person or one named service. Shared accounts are not allowed.

Joiners, movers, leavers:

- Joiner: the manager requests a role; access is granted from the role profile, at the start date and not before it is needed.
- Mover: on a role change, access is recalculated. Rights from the old role are removed within [5] working days — access must not pile up over a career.
- Leaver: all access is removed on the last working day at the latest, following the offboarding checklist in the People Security Policy.

Access reviews:

- Admin and privileged roles are reviewed every [3] months; all other access at least every [6] months.
- Bee Flow's machine-verified access registry shows who currently has what. Reviewers confirm or revoke each entry, and the outcome is recorded in the Compliance Hub as evidence.
- Unused accounts and stale API keys found in a review are disabled first and questioned second.

Privileged access:

- Admin rights are given only where the role clearly requires them, and through a separate admin identity where practical.
- Multi-factor authentication is required for every account, and without exception for admin and remote access.
- Privileged actions are logged and cannot be edited by the person performing them.

Authentication:

- Sign-in goes through SSO or MFA-protected accounts. Passwords live in a password manager, not in files or chat.
- Sessions expire; tokens and API keys have owners and expiry dates.

## Roles & responsibilities

- System owners: define role profiles and approve exceptions for their system.
- Managers: request access changes on time and take part in reviews.
- IT/admins: carry out grants and removals within the agreed deadlines.
- ISMS lead ({owner}): runs the review cycle and checks that the access registry matches reality.

## Review

The ISMS lead ({owner}) reviews this policy every 12 months, and after any incident in which access rights played a role. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'cryptography',
        title: 'Cryptography Policy',
        controls: ['A.8.24'],
        reviewMonths: 12,
        body: `# Cryptography Policy

## Purpose

Encryption protects our data even when a disk, a backup, or a network connection falls into the wrong hands. This policy fixes which algorithms and protocols {org} uses, so that every system applies the same modern, well-tested cryptography — and nobody invents their own.

## Scope

All {org} data at rest and in transit, and all keys, secrets, and certificates. This covers the Bee Flow deployment, backups, integrations, and any other service that stores or moves our data.

## Policy

Approved algorithms and protocols:

- Symmetric encryption: AES-256-GCM.
- Password hashing and key derivation: Argon2id.
- Login: the OPAQUE protocol for zero-knowledge authentication where the platform supports it; otherwise passwords are stored as Argon2id hashes only.
- Transport: TLS 1.3 preferred, TLS 1.2 as the minimum, with certificates from a trusted CA and automatic renewal.
- Asymmetric cryptography and signatures: elliptic-curve (P-256 or Ed25519) or RSA with keys of 3072 bits or more.
- Not allowed for security purposes: MD5, SHA-1, DES, 3DES, RC4, ECB mode, and any self-designed algorithm or protocol.

The envelope model:

- Bee Flow encrypts workspace content with per-item data keys (AES-256-GCM). Those data keys are wrapped with keys derived from user and organisation secrets via Argon2id. The result is zero-knowledge: the platform operator cannot read content without the user's secret.
- Nobody weakens or bypasses this model. New features that store user content must use the same envelope pattern, and changes to it always go through security review.

Key management:

- Keys are generated with a cryptographically secure random generator and never reused for a different purpose.
- Private keys and master secrets never appear in code, commits, tickets, chat, or logs. They live only in the systems that need them.
- Every key has a named custodian. Keys are rotated on any suspicion of compromise and on a fixed schedule of [rotation interval].
- Old keys are retired, not destroyed, for as long as encrypted data still depends on them.
- Recovery is designed up front: document here how encrypted data is recovered when someone leaves or loses their secret ([recovery approach]). With zero-knowledge encryption, a lost key without a recovery path means lost data — that trade-off must be a conscious choice.

## Roles & responsibilities

- ISMS lead ({owner}): owns the list of approved algorithms and approves any exception in writing, with an expiry date.
- Engineers: use approved, maintained cryptographic libraries and never write their own primitives.
- Admins: keep TLS configuration current and monitor certificate renewal so nothing expires unnoticed.
- Everyone: reports suspected key or secret exposure immediately as an incident.

## Review

The ISMS lead ({owner}) reviews this policy every 12 months, and earlier when an approved algorithm is weakened by new research or when the platform adds new cryptographic features. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'incident-response',
        title: 'Incident Response Policy',
        controls: ['A.5.24', 'A.5.25', 'A.5.26', 'A.5.27', 'A.5.28', 'A.6.8'],
        reviewMonths: 12,
        body: `# Incident Response Policy

## Purpose

When something goes wrong, {org} responds fast, calm, and in a consistent way. This policy describes how we report, classify, and handle security incidents, how we meet the GDPR breach deadlines, and how we learn afterwards.

## Scope

All security events and incidents that affect {org} information or systems: breaches, data leaks, lost devices, outages, misbehaving AI agents or automations, and anything that looks suspicious. It applies to everyone, including suppliers with access to our systems.

## Policy

Reporting:

- Report anything suspicious immediately to [report channel, e.g. security@{org} or the #security channel] — a strange login prompt, a lost laptop, a phishing email, an agent doing something unexpected. When in doubt, report.
- Reporting is everyone's duty, and reporting in good faith is never punished. The person who reports fastest helps most.
- External parties can report through [external contact point].

Triage and severity:

- The incident lead triages new reports within [4] hours and assigns a severity:
  - SEV1 — critical: active attack, confirmed data leak, or full outage.
  - SEV2 — high: serious but contained impact, or a credible threat to confidential data.
  - SEV3 — normal: limited impact, no confidential data involved.
- Every incident is recorded in the Compliance Hub incident register, which keeps the timeline, decisions, actions, and evidence in one place.

Personal data breaches (GDPR):

- The 72-hour clock starts the moment we become aware of a likely personal data breach. The DPO assesses whether the supervisory authority must be notified; the incident register's 72h workflow tracks that deadline so it cannot slip by unnoticed.
- If the breach brings a high risk for the people involved, we inform them without delay, in plain language, with practical advice.

Response steps:

- Contain first, then investigate, remove the cause, recover, and close. Do not destroy traces while containing.
- Evidence: preserve logs, screenshots, and copies before changing systems. Note who collected what and when, and store evidence with restricted access, so it holds up later.
- Communication: one person coordinates all external messages. Nobody else talks to press, customers, or authorities about an open incident.

Lessons learned:

- Every SEV1 and SEV2 incident gets a blameless review within [10] working days: what happened, what worked, what we change. Actions get an owner and a date and are tracked in the Compliance Hub until done.

## Roles & responsibilities

- Incident lead ({owner}): coordinates the response, sets severity, and keeps the register current.
- DPO/privacy contact: runs the GDPR assessment and handles notification to the authority and to data subjects.
- Engineers and admins: contain, recover, and preserve evidence.
- Management: is informed at once for SEV1 and approves external communication.
- Everyone: reports and follows instructions during an incident.

## Review

The incident lead ({owner}) reviews this policy after every SEV1 incident and at least every 12 months, including a test run of the report channel. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'business-continuity',
        title: 'Business Continuity & Disaster Recovery',
        controls: ['A.5.29', 'A.5.30', 'A.8.13', 'A.8.14'],
        reviewMonths: 12,
        body: `# Business Continuity & Disaster Recovery

## Purpose

This policy makes sure {org} keeps working during a disruption and can restore data and services within agreed limits. A backup we have never restored, and a plan we have never tested, count as neither.

## Scope

The services {org} depends on: the Bee Flow workspace, its databases and file storage, supporting services, and critical third-party services. It covers technical failures, cyber attacks, provider outages, and the loss of key people or premises.

## Policy

Objectives — replace with your real numbers:

- Recovery Time Objective (RTO): [X hours] — the longest we accept a critical service being down.
- Recovery Point Objective (RPO): [X hours] — the most data loss we accept, measured in time.
- If systems differ, record the RTO/RPO per system in the asset register.

Backups:

- Databases and file storage are backed up automatically at least daily.
- Backups are encrypted (AES-256-GCM) in transit and at rest, and stored in a separate location and account from production, inside the EU.
- Retention is [30] days, unless law or contract requires longer.
- At least one backup copy is protected against deletion with production credentials — immutable storage, a separate account, or offline. Ransomware that reaches production must not reach the backups.

Restore testing:

- We test a restore at least every [3] months: pick a real backup, restore it to an isolated environment, and verify the data is complete and usable.
- Each test's result, duration, and issues are recorded in the Compliance Hub as evidence. A failed test is handled as an incident, not as a note.

Failover and resilience:

- Single points of failure are documented in the risk register. Where risk justifies it, we run redundant instances or a failover setup: [describe your setup, or record the accepted risk].
- An up-to-date contact list (key people, hosting provider, key suppliers) is stored somewhere reachable even during a full outage.

During a disruption:

- The Incident Response Policy governs the first hours. The continuity owner invokes this plan when a disruption exceeds [threshold, e.g. 4 hours of downtime].
- We communicate honestly with users and customers about impact and expected recovery, and update them at set intervals.

Afterwards:

- Every real disruption gets a review; findings feed the risk register and this plan.

## Roles & responsibilities

- Continuity owner ({owner}): owns this plan, the test calendar, and the RTO/RPO proposals.
- Admins and engineers: implement backups, run restore tests, and execute recovery.
- Management: accepts the RTO/RPO targets and any residual risk.
- Everyone: knows where this plan lives and who to call.

## Review

The continuity owner ({owner}) reviews this policy every 12 months, and after every real disruption or failed restore test. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'supplier-security',
        title: 'Supplier & Cloud Services Policy',
        controls: ['A.5.19', 'A.5.20', 'A.5.21', 'A.5.22', 'A.5.23'],
        reviewMonths: 12,
        body: `# Supplier & Cloud Services Policy

## Purpose

Suppliers and cloud services process our data and keep our systems running, so their security becomes our security. This policy makes sure {org} chooses suppliers consciously, contracts with them properly, keeps watching them, and can leave without losing data.

## Scope

All suppliers and cloud services that touch {org} information or support critical processes: hosting providers, SaaS tools, AI model providers, subprocessors, and support or maintenance parties.

## Policy

The register:

- Every supplier is recorded in the supplier and cloud service register in the Compliance Hub: what they do for us, what data they see, where the data is stored, contract and DPA status, the internal owner, and a risk level.
- No register entry means not approved. This includes free tiers and trials — a free tool that receives company data is a supplier.

Before onboarding (due diligence, proportionate to risk):

- Check the supplier's security posture: certifications such as ISO 27001 or SOC 2, a public security page, or our questionnaire for smaller parties.
- Check where data is processed. EU/EEA processing is preferred. Transfers outside the EEA need standard contractual clauses (SCCs) or an adequacy decision, recorded in the register.
- A data processing agreement (DPA) is signed before any personal data flows.
- For AI model providers: verify whether prompts or outputs are used for training. If they are and it cannot be switched off, the provider is not approved.

During the relationship:

- The supplier owner reviews high-risk suppliers at least yearly: incidents, certificate renewals, and subprocessor changes.
- A supplier security incident that affects our data runs through our Incident Response Policy, including the GDPR clock.
- Supplier access to our systems follows the Access Control Policy: least privilege, time-limited, and logged.

Changes and exit:

- Suppliers must announce subprocessor changes; we assess before accepting them.
- Before signing, we record the exit path: how we get our data out, in which format, within what time, and how deletion after termination is confirmed in writing.
- When a contract ends, the owner closes the register entry only after the data return and deletion confirmation are in.

## Roles & responsibilities

- Supplier owner (named per supplier in the register): keeps the entry current and runs the periodic review.
- ISMS lead ({owner}): maintains the register and approves new suppliers.
- DPO: reviews DPAs and transfer mechanisms.
- Budget holders and everyone else: no new tools outside this process, however convenient they look.

## Review

The ISMS lead ({owner}) reviews this policy every 12 months, together with a completeness check of the register against actual spending and integrations. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'secure-development',
        title: 'Secure Development Policy',
        controls: ['A.8.25', 'A.8.26', 'A.8.27', 'A.8.28', 'A.8.29', 'A.8.30', 'A.8.31'],
        reviewMonths: 12,
        body: `# Secure Development Policy

## Purpose

Security is built in while we develop, not bolted on afterwards. This policy sets the ground rules for how {org} writes, reviews, tests, and ships software so that our changes do not become our incidents.

## Scope

All software {org} builds and operates: application code, infrastructure-as-code, CI/CD pipelines, and the automations and agent configurations built in Bee Flow Studio. It applies to our own developers and to external developers working for us.

## Policy

Repositories and reviews:

- All code lives in version control. The default branch is protected: changes arrive by pull request, at least one other person reviews, and CI must pass before merge.
- Reviews look at security, not only style: input handling, authorisation checks, error handling, new dependencies, and anything touching personal data.

Secrets:

- Secrets never go into code, commits, tickets, or chat. They live in environment configuration or a secret manager.
- A secret scanner runs in CI and before commits. A leaked secret is rotated immediately and handled as an incident — even when we believe nobody saw it.

Dependencies:

- Dependencies come from trusted registries and are updated on a regular schedule of [monthly]. Critical security patches are applied within [X] days.
- Automated vulnerability alerts are triaged at least weekly; the outcome (fix, accept, or not applicable) is recorded.

Environments and test data:

- Development, test, and production are separated. Production credentials are never used in development or test.
- No production personal data in test environments. Use synthetic or anonymised data. If a production copy is truly unavoidable, the DPO approves it in writing and the copy is deleted right after use.

Security in design:

- Features that process personal data or change authentication or authorisation start with a short design review. High-risk processing triggers the DPIA check in the Compliance Hub.
- Changes to the encryption envelope, the Privacy Shield, or the access registry always require review by [senior engineer or ISMS lead] — no exceptions for small fixes.

Releases:

- Deployments are automated and repeatable. Who deployed what, and when, is traceable.
- Every release has a rollback path, and we know it works because we have used it.

Outsourced development:

- External developers follow this policy; the contract says so, and their access follows the Access Control Policy.

## Roles & responsibilities

- Engineering lead ({owner}): owns this policy, the branch protection rules, and the review standards.
- Developers: follow the rules above and raise concerns during review rather than after release.
- ISMS lead: audits samples of merged changes for compliance with this policy.
- DPO: approves any exceptional use of production data in test.

## Review

The engineering lead ({owner}) reviews this policy every 12 months, and after any incident caused by a change. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'hr-security',
        title: 'People Security Policy',
        controls: ['A.6.1', 'A.6.2', 'A.6.3', 'A.6.4', 'A.6.5', 'A.6.6'],
        reviewMonths: 12,
        body: `# People Security Policy

## Purpose

Most security incidents start with people — a rushed click, a missed offboarding, an unclear responsibility. This policy describes what {org} does before someone starts, while they work here, and when they leave, so that people are our strongest control instead of our weakest link.

## Scope

Everyone who works for or with {org}: employees, contractors, interns, and temporary staff, across all roles and locations.

## Policy

Before the start:

- We verify identity and the right to work, and we check references or diplomas where they matter for the role.
- For roles with privileged access or financial authority we ask for [a certificate of conduct / background check, where the law allows it]. Screening stays proportionate: we check what the role justifies, nothing more.
- Contracts contain a confidentiality clause that keeps working after the contract ends, and name the security responsibilities of the role.

During employment:

- Everyone completes security awareness training within the first [2] weeks and a refresher every year. Completion is tracked in the Compliance Hub, and the numbers are part of the management review.
- Roles with extra responsibility — developers, admins, the incident lead — get role-specific training on top.
- Everyone knows the report channel from the Incident Response Policy and knows that reporting in good faith is always safe.
- Deliberate or repeated policy violations go through the HR disciplinary process. Measures are proportionate and documented. Honest mistakes are treated as learning input, not as offences.

Changing roles or leaving:

- A role change triggers the mover process from the Access Control Policy: access is recalculated, and old rights are removed.
- Offboarding follows a checklist: all access removed on the last working day at the latest, devices and other assets returned, and files or knowledge bases the person owned handed over to their manager.
- The exit conversation reminds the person of the confidentiality duty that continues after departure.

## Roles & responsibilities

- HR ({owner}): owns screening, contracts, the disciplinary process, and triggers on- and offboarding on time.
- Managers: request access changes the moment a start, move, or exit is known, and make sure their people finish training.
- ISMS lead: provides the training content, tracks completion, and reports gaps.
- Everyone: completes training on time and lives by the policies it explains.

## Review

The policy owner ({owner}) reviews this policy every 12 months, together with a spot check on recent onboardings and offboardings: was access granted and removed on time, and was training completed? Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'asset-management',
        title: 'Asset Management Policy',
        controls: ['A.5.9', 'A.5.10', 'A.5.11', 'A.5.12', 'A.5.13', 'A.5.14'],
        reviewMonths: 12,
        body: `# Asset Management Policy

## Purpose

We can only protect what we know we have. This policy describes how {org} keeps track of its assets, how we classify information by sensitivity, and which handling rules follow from that classification.

## Scope

All assets that carry or process {org} information: hardware (laptops, phones, servers), software and SaaS subscriptions, information assets (databases, document sets, knowledge bases), and AI assets (models, agents, automations, and their system instructions).

## Policy

Inventory:

- All assets are recorded in the asset register in the Compliance Hub. Every entry has an owner, a description, a classification, and a location.
- New assets enter the register at intake; the register is checked for completeness every [3] months.
- AI assets are inventoried like everything else, including which data sources a model, agent, or knowledge base can reach. An agent with access to confidential data is a confidential asset.

Classification — three levels:

- Public: meant for the outside world. Loss causes no damage.
- Internal: normal work information. A leak would be unpleasant but limited.
- Confidential: personal data, customer workspace content, credentials, financials, strategy. A leak causes serious damage. Customer content in Bee Flow is Confidential by default.
- The asset owner classifies. When unsure, pick the higher level.

Labeling and handling:

- Assets are labeled with their level where practical — in document metadata, register entries, or system settings.
- Handling follows the level: who may access it, whether it may leave approved systems, and whether encryption is required. Confidential information is always encrypted at rest and in transit and shared only through approved channels.

Transfer:

- Use approved sharing mechanisms: Bee Flow sharing and [other approved services]. Confidential data never travels via private email or consumer file-sharing tools.
- Transfers of personal data to external parties follow the Supplier & Cloud Services Policy — a DPA must be in place first.

Return and disposal:

- Assets are returned at offboarding, as described in the People Security Policy.
- Storage media are securely wiped or physically destroyed before disposal, and the disposal is recorded.
- Cloud-stored data is deleted according to the retention schedule, and deletion at contract end is confirmed in writing by the supplier.
- Paper with confidential information goes through the shredder, not the paper bin.

## Roles & responsibilities

- Asset owners: keep their entries current, classify correctly, and decide who may access their assets.
- ISMS lead ({owner}): maintains the register and runs the completeness checks.
- IT/admins: handle secure disposal and record it.
- Everyone: labels what they create and handles information according to its level.

## Review

The ISMS lead ({owner}) reviews this policy every 12 months, alongside the quarterly register checks. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'logging-monitoring',
        title: 'Logging & Monitoring Policy',
        controls: ['A.8.15', 'A.8.16', 'A.8.17'],
        reviewMonths: 12,
        body: `# Logging & Monitoring Policy

## Purpose

Logs tell us what actually happened. {org} logs and monitors to detect attacks early, to investigate incidents properly, and to prove that controls work — while logging no more than that purpose needs, because we are a privacy-first organisation.

## Scope

All production systems and security-relevant services of {org}, including the Bee Flow platform, its infrastructure, admin tooling, and the services around them.

## Policy

What we log:

- Authentication events: successful and failed sign-ins, MFA changes, password resets.
- Admin and privileged actions, and every permission or role change — the access registry records each grant and revocation.
- Security control events: Privacy Shield and DLP hits, blocked guardrail attempts, and failed authorisation attempts.
- Compliance-relevant lifecycle events: DSR handling, data exports, deletions, and incident register actions.
- System health: errors, availability, and resource limits.
- We do not log message content, prompts, or secrets. Logging is minimised to its purpose, in line with the monitoring notice in the Acceptable Use Policy.

Protection and retention:

- Logs are protected against tampering: the systems and people that produce events cannot edit or delete their own log entries.
- Access to logs is restricted to [named roles], and that access is itself logged.
- Retention: security logs are kept [12] months, operational system logs [30–90] days, unless law or contract requires otherwise. After that they are deleted, not archived out of habit.

Clock synchronisation:

- All systems synchronise their clocks via NTP against a common source. Correct timestamps are what make correlation across systems — and usable evidence — possible.

Review and alerting:

- Automated alerts fire for at least: repeated failed sign-ins, new admin grants, unusual guardrail spikes, backup failures, and certificates close to expiry. [Extend this list with your own alerts.]
- Alerts go to [channel] and always have an owner; an alert nobody owns is noise.
- A human reviews the security dashboards and open alerts every [week]. Anything that looks like an incident moves to the Incident Response Policy.
- After every incident we ask: would our alerts have caught this sooner? The answer updates the alert rules.

## Roles & responsibilities

- ISMS lead ({owner}): owns the list of logged events and alert rules, and runs the periodic review.
- Admins/engineers: keep the logging pipeline healthy and report gaps — a silent log source is a finding.
- Incident lead: uses logs during investigations and flags missing coverage.
- DPO: checks that logging stays proportionate and inside the monitoring notice given to staff.

## Review

The ISMS lead ({owner}) reviews this policy every 12 months, together with a sample check that the events listed above really appear in the logs. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'risk-management',
        title: 'Risk Management Methodology',
        controls: ['6.1.2', '6.1.3', 'A.5.7'],
        reviewMonths: 12,
        body: `# Risk Management Methodology

## Purpose

This document describes how {org} finds, scores, treats, and follows up on information security risks. It is the engine behind the ISMS: controls exist because a scored risk justifies them, and the Statement of Applicability points back to this method.

## Scope

All information security risks to {org}, including AI-specific risks (model behaviour, prompt injection, data leakage through model output) and privacy risks — which also feed the DPIA process in the Compliance Hub when processing is high-risk.

## Policy

Identification:

- Risks come from: asset register walkthroughs, incidents and near misses, audit findings, supplier reviews, and threat intelligence. Security advisories, CERT feeds, and vendor bulletins are checked every [week]; anything relevant to our stack becomes a risk register entry or an action.
- Anyone can raise a risk with the ISMS lead. Every risk is recorded in the risk register in the Compliance Hub with a description, an owner, and the affected assets.

Scoring — 5×5 matrix:

- Likelihood, 1 to 5: 1 = rare (not expected within five years), 2 = unlikely, 3 = possible (could happen this year), 4 = likely, 5 = almost certain (expected within months).
- Impact, 1 to 5: 1 = negligible, 2 = minor, 3 = serious (real damage, recoverable), 4 = major, 5 = severe (large legal, financial, or reputational damage, or real harm to individuals).
- Risk score = likelihood × impact, giving 1–25. Bands: 1–4 low, 5–9 medium, 10–15 high, 16–25 critical.

Acceptance threshold:

- Low: the risk owner may accept and record it.
- Medium: the ISMS lead decides between treatment and documented acceptance.
- High: must be treated; only management may accept a high risk, in writing, with a review date.
- Critical: is never simply accepted — treatment starts immediately.

Treatment options:

- Reduce: add or improve a control, linked to the relevant Annex A control in the SoA.
- Transfer: insurance or contract terms — the damage moves, the responsibility does not.
- Avoid: stop or change the activity that creates the risk.
- Accept: only within the threshold above, and always documented.
- Every treatment gets an owner, a deadline, and an expected new score. Done is not the same as effective: after implementation we re-score and verify.

Cadence:

- The full register is reviewed at least yearly, and additionally on major change: a new system, supplier, incident, or law.
- High and critical risks are reviewed every [3] months, and treatment progress is a fixed item in the management review.

## Roles & responsibilities

- Management: confirms the acceptance threshold, accepts high risks, and reviews the top risks.
- ISMS lead ({owner}): owns this methodology and the register, and drives the cadence.
- Risk owners: treat their risks and report progress honestly.
- Everyone: raises risks — spotting one is a contribution, not a complaint.

## Review

The ISMS lead ({owner}) reviews this methodology every 12 months. The matrix definitions change only with management approval, so that scores stay comparable over the years. Review dates are tracked in the Compliance Hub document register.
`,
    },
    {
        slug: 'exit-procedure',
        title: 'Exit and data-portability procedure',
        controls: ['A.5.30', 'A.5.29'],
        reviewMonths: 12,
        body: `# Exit and data-portability procedure

## Purpose

This procedure describes how {org} hands data back and winds down a service when a customer leaves, when we stop using a supplier, or when we end a service ourselves. Leaving must be as orderly as joining: the customer gets their data in a usable form, nothing lingers where it should not, and the business keeps running while the switch happens. It also gives customers the switching rights the Data Act grants them.

## Scope

Every service {org} provides to customers on which they store or process data — the Bee Flow workspace and everything connected to it — and every supplier {org} depends on for those services. It covers structured data (records, tables, conversations), files and documents, configuration such as agents, automations and knowledge bases, and the logs a customer is entitled to.

## Policy

Leaving customers:

- A customer may end the service with a notice period of at most [30] days. We never charge for the switch itself, and we never make leaving harder than staying: no undocumented formats, no missing exports, no silent lock-in.
- On request, and in any case at the end of the notice period, we deliver a complete export of the customer's data in the documented, machine-readable formats listed in the Compliance Hub portability matrix. The customer receives a manifest with checksums so they can verify the hand-over.
- The export contains only that customer's data. Nothing of another tenant may leak into it — the export route is tested with a second tenant present.
- After the export is confirmed and the retention period has passed, we delete the customer's data, including backups within [90] days, and we confirm the deletion in writing. Encryption keys are destroyed with the data.
- Personal data that we must keep longer for a legal reason is documented per case, with the reason and the date it will be deleted.

Leaving suppliers:

- Before we adopt a supplier we record how we would leave them: which data sits there, in which format we get it back, and how long the migration would take. A supplier without a documented exit is a risk register entry.
- When we end a supplier relationship we retrieve or migrate our data first, then request and record their confirmation of deletion.

Testing:

- We rehearse the customer exit at least once a year with a real export of a test organisation: is it complete, does it import elsewhere, does the checksum match, how long did it take? The result, the date and the tester are recorded in the Compliance Hub, and the findings feed the risk register.
- Continuity during the switch is part of the test: the service must keep working for the customer until they confirm the hand-over.

## Roles & responsibilities

- Service owner: runs the exit for a customer, delivers the export and the manifest, and confirms the deletion.
- ISMS lead ({owner}): owns this procedure, schedules the yearly rehearsal and records its outcome.
- Supplier owners: keep the exit notes for their suppliers current.
- Support: answers a customer's exit request within [5] working days and points them to the export.

## Review

The ISMS lead ({owner}) reviews this procedure every 12 months and after every rehearsal that finds a problem, a new export route, or a change in the Data Act or our contracts. Review dates are tracked in the Compliance Hub document register.
`,
    },
];

module.exports = { POLICY_SEEDS };
