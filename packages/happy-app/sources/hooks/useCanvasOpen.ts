import * as React from 'react';
import { loadCanvasOpen, saveCanvasOpen } from '@/sync/persistence';

/**
 * Whether the canvas panel is open in one session, remembered per session on
 * this device.
 *
 * The session screen stays mounted when you switch sessions (only its session
 * id changes), so a plain `useState` carried one session's panel state into the
 * next and reset to closed on the way back. Reading the stored value on every
 * render instead ties the state to the session id: MMKV reads are synchronous
 * and tiny, and a counter re-renders after a write.
 */
export function useCanvasOpen(sessionId: string | null | undefined): [boolean, (open: boolean) => void] {
    const [, rerender] = React.useReducer((n: number) => n + 1, 0);
    const open = !!sessionId && loadCanvasOpen(sessionId);
    const setOpen = React.useCallback((next: boolean) => {
        if (!sessionId) return;
        saveCanvasOpen(sessionId, next);
        rerender();
    }, [sessionId]);
    return [open, setOpen];
}
