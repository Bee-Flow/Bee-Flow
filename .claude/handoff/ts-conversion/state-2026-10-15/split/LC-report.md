# L-C report: remaining agent-hub JS sweep (laptop)

Status: round 1 drafted (p1a utils/lib, p1b shared, p2 editor, p3 meeting-notes); Opus review + merge test next.
Done: 0/314 files on this branch (drafts: p1b 15, p2 1, p3 5, p1a pending), 0 packages merged.
Next: review + integrate round 1, full checks, push (~2-3 h); then round 2 (p4-p7).

Branch `ts-laptop/sweep-c`. BASE `0ae29a17` (= origin/ccr-28820270-xkvwp8 at branch time; ts-local/prep2 already in it).
Final commit: see `git log -1` of the branch (this file is updated with every push).

## Scope
Every agent-hub JS file outside components/admin/Studio/**, components/admin/compliance/**,
components/admin/product-website/**, components/automation/Builder/**: 314 files at BASE.
Left out by instruction: AuthedApp.jsx, AgentHub.jsx, AgentHub/useAgentHubData.js,
components/chat/InputArea/index.jsx, components/skills/SkillsPopover.jsx,
components/onboarding/generated/**, src/i18n/en-defaults.js.
Stays JS by rule (react-hooks eslint-disable): StudioSectionHeader.jsx, SkillFormModal.jsx,
ComposerPill.jsx, RemoteStudioApp.jsx, BeeEditor.jsx, LearningCenterSection.jsx.

Packages (fan-in first; round 1 = the most-imported shared modules):
| Package | Area | Files | Round |
|---|---|---|---|
| p1a | utils, lib, config, moduleRuntime, theme | 37 | 1 |
| p1b | components/shared, components/apps | 21 | 1 |
| p2 | editor | 15 | 1 |
| p3 | pages/meeting-notes, components/global | 25 | 1 |
| p4 | chat, AgentHub, cowork, skills, shell, support, knowledge, renderers | 40 | 2 |
| p5 | agents, automation/index | 27 | 2 |
| p6 | admin (rest), integrations, AdminDashboard, OrgSettings | 54 | 2 |
| p7 | pages/settings, pages/login, top-level settings/login pages | 37 | 2 |
| p8 | documents, webpages, marketing, demo, onboarding, entry files | 57 | 3 |

## Status per package
(filled in as packages are integrated)

## Push log
| Pushed commit | check:fast | server typecheck | duplication (prod / test) | gitleaks | agent-hub tsc | agent-hub vitest | mobile tsc | mobile jest | server npm test |
|---|---|---|---|---|---|---|---|---|---|

## Integrator: watch at merge
(filled in as packages are integrated)
