import * as React from 'react';
// @ts-expect-error react-test-renderer has no declarations in this workspace.
import { act, create } from 'react-test-renderer';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('react-native-mmkv', () => ({ MMKV: class {
    getString = (key: string) => disk.values.get(key) as string | undefined;
    getBoolean = (key: string) => disk.values.get(key) as boolean | undefined;
    set = (key: string, value: unknown) => { disk.values.set(key, value); };
    delete = (key: string) => { disk.values.delete(key); };
} }));

import { useCanvasOpen } from './useCanvasOpen';

const originalError = console.error;
beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    console.error = (message: unknown, ...rest: unknown[]) => {
        if (typeof message === 'string' && message.startsWith('react-test-renderer is deprecated')) return;
        originalError(message, ...rest);
    };
});
afterAll(() => { console.error = originalError; });
beforeEach(() => disk.values.clear());

function mount(sessionId: string) {
    const seen: { open: boolean; setOpen: (open: boolean) => void } = { open: false, setOpen: () => {} };
    function Probe(props: { sessionId: string }) {
        const [open, setOpen] = useCanvasOpen(props.sessionId);
        seen.open = open;
        seen.setOpen = setOpen;
        return null;
    }
    let renderer: any;
    act(() => { renderer = create(React.createElement(Probe, { sessionId })); });
    const switchTo = (id: string) => act(() => renderer.update(React.createElement(Probe, { sessionId: id })));
    return { seen, switchTo };
}

it('keeps the panel open when you leave a session and come back', () => {
    const { seen, switchTo } = mount('a');
    expect(seen.open).toBe(false);
    act(() => seen.setOpen(true));
    expect(seen.open).toBe(true);

    switchTo('b');
    expect(seen.open).toBe(false);

    switchTo('a');
    expect(seen.open).toBe(true);
});

it('forgets a closed panel instead of storing false', () => {
    const { seen } = mount('a');
    act(() => seen.setOpen(true));
    act(() => seen.setOpen(false));
    expect(seen.open).toBe(false);
    expect(disk.values.size).toBe(0);
});
