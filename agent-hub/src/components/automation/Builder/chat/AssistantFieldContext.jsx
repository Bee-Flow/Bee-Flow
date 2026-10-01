import { createContext, useContext } from 'react';

const AssistantFieldContext = createContext(null);
export const AssistantFieldProvider = AssistantFieldContext.Provider;
export function useAssistantField() { return useContext(AssistantFieldContext); }
