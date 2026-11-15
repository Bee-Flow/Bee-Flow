import { createContext } from 'react';

/**
 * Whether a Subscriptions view draws its own title. false under the admin
 * dashboard frame, which already draws the page heading.
 */
export const SubscriptionsTitledContext = createContext(true);
