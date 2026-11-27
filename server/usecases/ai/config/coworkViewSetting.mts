/**
 * The Cowork view a person chose after the Cowork introduction ('orb', 'chat'
 * or 'advanced'), part of GET/POST /ai/user-settings. Kept per person on the
 * server, so the introduction plays once per person on any device: it is set
 * the moment the introduction starts, and the choice at its end replaces it.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z } = nodeRequire('../../../utils/zod.js') as typeof import('../../../utils/zod.js');

const COWORK_VIEWS = ['orb', 'chat', 'advanced'] as const;

/** The schema field of POST /ai/user-settings. */
export const coworkViewField = {
    coworkView: z.enum(COWORK_VIEWS, { error: () => "coworkView is 'orb', 'chat' or 'advanced'." }),
};

/** The config key the view is stored under. */
export const coworkViewKey = (userId: string) => `cowork_view_user_${userId}`;

/** A stored value as a view, or null while the person has not seen the introduction. */
export const coworkViewOf = (value: unknown) => COWORK_VIEWS.find((view) => view === value) ?? null;
