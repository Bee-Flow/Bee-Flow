/**
 * Studio's one write-shaped call: "Describe it". The route stores nothing,
 * but a press of a button that spends a model call is a mutation, never a
 * cached query — the same sentence twice is asked twice.
 */

import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { routeDescription } from '../api/endpoints';
import type { DescribeItAnswer } from '../model/api';

/** A 200 whose body is not an answer: "could not read that", never "the AI chose nothing". */
function unreadable(): Error {
    return new Error('The answer could not be read.');
}

/**
 * Ask which building block a description is about. `cancel` really aborts
 * the request (the web's Cancel does too) and forgets it, so its answer can
 * never land on a sheet that moved on; leaving the screen does the same.
 */
export function useRouteDescription() {
    const inFlight = useRef<AbortController | null>(null);
    const mutation = useMutation({
        mutationFn: async (text: string): Promise<DescribeItAnswer> => {
            const controller = new AbortController();
            inFlight.current = controller;
            const answer = await routeDescription(text.trim(), controller.signal);
            if (!answer) throw unreadable();
            return answer;
        },
    });
    useEffect(() => () => inFlight.current?.abort(), []);
    const cancel = () => {
        inFlight.current?.abort();
        inFlight.current = null;
        mutation.reset();
    };
    return { ...mutation, cancel };
}
