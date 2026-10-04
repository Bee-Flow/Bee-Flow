import { API_BASE, authFetch } from '../../../../utils/helpers';
import { computeScheduleNextRun } from '../../../../utils/scheduleNextRun';
import { configuredTierKeys } from '../../../licensing/tierMeta';
import { buildRefineContext, diffRefinedPlan, mergeRefinedPlan } from '../state/refineMerge';

// The refine-chat pipeline for BuilderSplit, moved here verbatim. The factory
// is called once per render (right after the derived values it needs are
// computed), and the returned handler closes over the deps object properties
// exactly as it closed over the parent scope before. No hooks in this module.
export function createHandleRefine({ chat, setChat, chatInput, setChatInput, chatBusy, setChatBusy, setRefining, setInstructionsEditing, dirtyRef, flush, attachedSkillIds, setAttachedSkillIds, skillNamesById, name, setName, description, setDescription, avatar, setAvatar, setInstructions, setModel, setSelectedTier, setEnabledIntegrations, setKnowledgeBaseIds, stateRef, plan, chatTier, tier, locale, t, allSkills, setAllSkills, availableIntegrations, tiers, queueSave, schedulesAllowed, agent, refreshAgentSchedules, currentPersona, noStoredPersona = false }) {
    const handleRefine = async (overrideText = null) => {
        // Callers pass either a string (programmatic refine from the wizard
        // hand-off) or nothing (button/Enter). React event objects and similar
        // non-string values get treated as "no override" so we fall back to
        // the live chatInput.
        const usingOverride = typeof overrideText === 'string';
        const text = (usingOverride ? overrideText : chatInput).trim();
        if (!text || chatBusy) return;
        setChat(prev => [...prev, { role: 'user', content: text }]);
        if (!usingOverride) setChatInput('');
        setChatBusy(true);
        setRefining(true);
        // Close the instructions editor so its buffer can't race the refined
        // value (every keystroke is already mirrored into stateRef, so nothing
        // is lost). Flush any pending manual edit first so the refine's own save
        // is the only one that fires during this operation.
        setInstructionsEditing(false);
        if (dirtyRef.current) { try { await flush(); } catch (_) { /* best effort */ } }
        try {
            // Send the AI the CURRENT curated config and tell it to preserve it.
            const attachedSkills = (attachedSkillIds || []).map(id => {
                const s = skillNamesById.get(id);
                return { id, name: s?.name || '' };
            });
            const ctx = buildRefineContext({
                name,
                description,
                avatar,
                systemPrompt: stateRef.current.systemPrompt,
                capabilities: plan?.capabilities || stateRef.current.config?.wizard?.capabilities || [],
                model: stateRef.current.model,
                enabledIntegrations: stateRef.current.config?.enabledIntegrations || [],
                attachedSkills,
                knowledge_base_ids: stateRef.current.config?.knowledge_base_ids || [],
                // De rol zoals hij NU is, zodat een verfijning hem kan
                // bijstellen in plaats van hem opnieuw te verzinnen. Alleen de
                // vier beschrijvende velden reizen mee — zie personaFieldsOf.
                persona: currentPersona,
            });
            const res = await authFetch(`${API_BASE}/agents/wizard/refine`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    prompt: chat[0]?.content || '',
                    plan: ctx.plan,
                    current: ctx.current,
                    refinement: text,
                    modelTier: chatTier || tier || 'fast',
                    locale,
                }),
            });
            if (!res.ok) {
                // Structured, actionable error — a malformed model output (422)
                // is retryable; anything else surfaces the server reason. No
                // state was mutated, so the save pill stays coherent.
                let msg;
                try {
                    const body = await res.json();
                    msg = body?.reason === 'plan_parse_failed'
                        ? t('agent_wizard.builder.refine_parse_error', 'The assistant returned malformed output. Please try again.')
                        : (body?.error || `Refine failed (${res.status})`);
                } catch (_) { msg = `Refine failed (${res.status})`; }
                setChat(prev => [...prev, { role: 'error', content: msg }]);
                return;
            }
            const { plan: updated, preserved } = await res.json();

            // HET UNDO-PUNT, vóór de merge. Een pre_refine-rij is een gewone
            // agent_versions-rij, dus "ongedaan maken" is daarna een gewone
            // restore — één niveau diep, en van precies dit moment.
            //
            // De snapshot wordt pas NA een geslaagd antwoord genomen: een
            // mislukte verfijning verandert niets en hoort dus geen
            // herstelpunt achter te laten. Lukt de snapshot niet, dan gaat de
            // verfijning gewoon door (de gebruiker vroeg erom) maar draagt de
            // beurt `undoVersionId: null` en zégt de knop dat er niets te
            // herstellen is.
            let undoVersionId = null;
            if (agent?.id) {
                try {
                    const snapRes = await authFetch(`${API_BASE}/versions/${agent.id}/pre-refine`, { method: 'POST' });
                    if (snapRes.ok) {
                        const snap = await snapRes.json();
                        if (snap && typeof snap.id === 'string' && snap.id) undoVersionId = snap.id;
                    }
                } catch (_) { /* geen herstelpunt — de kaart zegt dat zelf */ }
            }

            // Resolve skills BEFORE the single save so attachedSkillIds are
            // valid. Base off stateRef (not the stale attachedSkillIds closure).
            const attach = new Set(stateRef.current.config?.attachedSkillIds || []);
            if (Array.isArray(updated.skills) && updated.skills.length > 0) {
                for (const s of updated.skills) {
                    if (s.id && (allSkills || []).some(x => x.id === s.id)) {
                        attach.add(s.id); // reuse an existing skill
                    } else if (!s.id && s.name) {
                        try {
                            const sres = await authFetch(`${API_BASE}/api/skills`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ name: s.name, description: s.description || '', instructions: s.instructions || '', isShared: false, dynamicActivation: false, automationId: null }),
                            });
                            if (sres.ok) {
                                const created = await sres.json();
                                if (created?.id) { setAllSkills(prev => [...(prev || []), created]); attach.add(created.id); }
                            }
                        } catch (_) { /* non-fatal — a failed skill is simply not attached */ }
                    }
                }
            }
            const resolvedSkillIds = Array.from(attach);

            // De staat ZOALS HIJ NU IS — één object, want het is tegelijk de
            // invoer van de merge en de linkerkant van de diff die de
            // "Gedaan"-beurt toont. `config` is hier nog de OUDE referentie;
            // mergeRefinedPlan bouwt een nieuw object, dus de diff blijft
            // achteraf leesbaar.
            //
            // `persona` komt NIET uit stateRef maar uit de geladen agent: dat
            // is wat er echt in de kolom staat, en zonder die invoer zou een
            // tweede verfijning de instellingen die de verfijning niet noemt
            // (toon, taal) verliezen — personaAfterRefine draagt ze alleen over
            // als hij ze meekrijgt. Onbekend blijft `undefined`, en dat betekent
            // "laat de kolom staan", niet "wis hem".
            const before = {
                name,
                description,
                systemPrompt: stateRef.current.systemPrompt,
                avatar,
                model: stateRef.current.model,
                config: stateRef.current.config,
                persona: currentPersona ?? undefined,
                // "Er is nog geen rij" — het enige antwoord dat de merge een
                // verse persona laat schrijven. Zonder deze vlag betekent een
                // ontbrekende persona "niet gelezen", en dan blijft de kolom
                // staan in plaats van overschreven te worden met een persona
                // waar `unknown` en `language` uit weggevallen zijn.
                noStoredPersona,
            };

            // Fold the whole plan into ONE canonical snapshot: preserve & patch.
            const merged = mergeRefinedPlan(
                before,
                updated,
                preserved,
                {
                    availableIntegrationIds: availableIntegrations.map(a => a.id),
                    selectableTierKeys: configuredTierKeys(tiers),
                    resolvedSkillIds,
                },
            );

            // Apply to stateRef (the canonical source the save reads) AND to
            // React state, in one synchronous block.
            stateRef.current.name = merged.name;
            stateRef.current.description = merged.description;
            stateRef.current.systemPrompt = merged.systemPrompt;
            stateRef.current.avatar = merged.avatar;
            stateRef.current.model = merged.model;
            stateRef.current.config = merged.config;
            // De persona reist mee. Zonder deze regel beschreef `agents.persona`
            // na een verfijning een prompt die niet meer bestaat: de merge
            // rekende hem al uit (A1c), maar niemand schreef hem weg — en bij
            // de eerstvolgende opslag rendert de server de OUDE velden gewoon
            // over de nieuwe instructies heen. Eenmalig: getSnapshot stuurt hem
            // mee en de bevestigde opslag ruimt hem weer op, zodat een gewone
            // bewerking nooit ongevraagd een persona meestuurt.
            stateRef.current.persona = merged.persona;
            setName(merged.name);
            setDescription(merged.description);
            setInstructions(merged.systemPrompt);
            setAvatar(merged.avatar);
            setModel(merged.model);
            if (typeof merged.model === 'string' && merged.model.startsWith('tier:')) setSelectedTier(merged.model.slice(5));
            setEnabledIntegrations(merged.config.enabledIntegrations || []);
            setAttachedSkillIds(merged.config.attachedSkillIds || []);
            setKnowledgeBaseIds(merged.config.knowledge_base_ids || []);

            // ONE atomic save of the merged snapshot.
            queueSave(true);

            // De "Gedaan: …"-beurt: wat er FEITELIJK veranderde (de diff van de
            // merge, niet het plan dat het model terugstuurde) plus het
            // undo-punt. `undoVersionId: null` is een echte waarde — de kaart
            // zegt dan dat er niets te herstellen valt, in plaats van iets
            // anders terug te zetten.
            setChat(prev => [...prev, {
                role: 'done',
                changes: diffRefinedPlan(before, merged),
                undoVersionId,
                undoState: 'idle',
            }]);

            // Schedule action: when the LLM detected a clear scheduling intent
            // and the user has the agent_routines beta, create the schedule
            // for this agent and surface a confirmation in the chat.
            if (updated.schedule && schedulesAllowed && agent?.id) {
                try {
                    const r = updated.schedule;
                    const tz = r.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
                    const nextRunAt = computeScheduleNextRun(r, tz);
                    const createRes = await authFetch(`${API_BASE}/api/cowork`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            agentId: agent.id,
                            title: r.title,
                            prompt: r.prompt,
                            repeatInterval: r.repeatInterval,
                            daysOfWeek: r.daysOfWeek,
                            timeOfDay: r.timeOfDay,
                            timezone: r.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'),
                            nextRunAt,
                        }),
                    });
                    if (createRes.ok) {
                        await refreshAgentSchedules();
                        setChat(prev => [...prev, { role: 'system', content: `⏰ Created schedule "${r.title}" — ${r.repeatInterval}${r.timeOfDay ? ` at ${r.timeOfDay}` : ''}.` }]);
                    }
                } catch (_) { /* non-fatal — chat already shows the plan update */ }
            }
        } catch (err) {
            setChat(prev => [...prev, { role: 'error', content: err.message }]);
        } finally {
            setChatBusy(false);
            setRefining(false);
        }
    };

    return handleRefine;
}
