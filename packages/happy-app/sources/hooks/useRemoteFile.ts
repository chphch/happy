/**
 * Reads, watches and writes one file on the session's machine.
 *
 * Extracted from FileViewPanel so the canvas panel shares it rather than
 * carrying a second copy. The parts worth not duplicating are the careful ones:
 * the write is guarded by the hash the content was read at, so two editors
 * cannot silently overwrite each other, and the poll is what lets a file the
 * agent just rewrote show up without the user reopening anything. A second
 * implementation of those would drift, and the drift would be invisible until
 * someone lost an edit.
 *
 * `filePath: null` means "nothing open" — the hook idles, polls nothing, and
 * reports `kind: 'idle'`.
 */
import * as React from 'react';
import { sessionReadFile, sessionWriteFile } from '@/sync/ops';

export type RemoteFileState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'binary' }
    | { kind: 'loaded'; content: string; originalHash: string | null };

export interface UseRemoteFileOptions {
    /** How often to check whether the file changed underneath us. 0 disables. */
    pollMs?: number;
    /** Message shown when a read fails; supplied by the caller so it can be translated. */
    readErrorMessage?: string;
}

export interface RemoteFileSaveResult {
    ok: boolean;
    /** True when the write was refused because the file changed under us. */
    conflict: boolean;
    /** Present on a non-conflict failure. */
    error?: string;
}

const DEFAULT_POLL_MS = 5000;

export function isBinaryExtension(filePath: string): boolean {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const binaryExts = [
        'png', 'jpg', 'jpeg', 'gif', 'bmp', 'svg', 'ico',
        'mp4', 'avi', 'mov', 'wmv', 'flv', 'webm',
        'mp3', 'wav', 'flac', 'aac', 'ogg',
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
        'zip', 'tar', 'gz', 'rar', '7z',
        'exe', 'dmg', 'deb', 'rpm',
        'woff', 'woff2', 'ttf', 'otf',
        'db', 'sqlite', 'sqlite3',
    ];
    return ext ? binaryExts.includes(ext) : false;
}

export function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export function decodeUtf8Bytes(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

export function encodeStringToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/** Matches the server's `crypto.createHash('sha256').update(str).digest('hex')`. */
export async function computeSHA256(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Reads and decodes, or null when the read failed or the bytes are not text. */
export async function readRemoteFile(sessionId: string, filePath: string): Promise<string | null> {
    const res = await sessionReadFile(sessionId, filePath);
    if (!res.success || !res.content) return null;
    try {
        return decodeUtf8Bytes(decodeBase64ToBytes(res.content));
    } catch {
        return null;
    }
}

/**
 * Text that decodes as UTF-8 can still be a binary file. A NUL byte settles it;
 * past that, a high share of control characters is the practical tell.
 */
function looksBinary(rawBytes: Uint8Array, decoded: string): boolean {
    if (rawBytes.some((byte) => byte === 0)) return true;
    if (decoded.length === 0) return false;
    const nonPrintable = decoded.split('').filter((ch) => {
        const code = ch.charCodeAt(0);
        return code < 32 && code !== 9 && code !== 10 && code !== 13;
    }).length;
    return nonPrintable / decoded.length > 0.1;
}

export function useRemoteFile(
    sessionId: string,
    filePath: string | null,
    options: UseRemoteFileOptions = {}
) {
    const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    const readErrorMessage = options.readErrorMessage ?? 'Failed to read file';

    const [state, setState] = React.useState<RemoteFileState>(filePath ? { kind: 'loading' } : { kind: 'idle' });
    const [editContent, setEditContent] = React.useState('');
    const [isSaving, setIsSaving] = React.useState(false);
    /** Content found on the machine that differs from what we loaded. */
    const [externalChange, setExternalChange] = React.useState<string | null>(null);

    const hasChanges = state.kind === 'loaded' && editContent !== state.content;

    // Load.
    React.useEffect(() => {
        if (!filePath) {
            setState({ kind: 'idle' });
            setEditContent('');
            setExternalChange(null);
            return;
        }

        let cancelled = false;
        setState({ kind: 'loading' });
        setExternalChange(null);

        if (isBinaryExtension(filePath)) {
            setState({ kind: 'binary' });
            return;
        }

        (async () => {
            try {
                const res = await sessionReadFile(sessionId, filePath);
                if (cancelled) return;

                if (!res.success || !res.content) {
                    setState({ kind: 'error', message: res.error || readErrorMessage });
                    return;
                }

                let rawBytes: Uint8Array;
                let decoded: string;
                try {
                    rawBytes = decodeBase64ToBytes(res.content);
                    decoded = decodeUtf8Bytes(rawBytes);
                } catch {
                    setState({ kind: 'binary' });
                    return;
                }
                if (looksBinary(rawBytes, decoded)) {
                    setState({ kind: 'binary' });
                    return;
                }

                const hash = await computeSHA256(decoded);
                if (cancelled) return;
                setState({ kind: 'loaded', content: decoded, originalHash: hash });
                setEditContent(decoded);
            } catch {
                if (!cancelled) setState({ kind: 'error', message: readErrorMessage });
            }
        })();

        return () => { cancelled = true; };
    }, [sessionId, filePath, readErrorMessage]);

    // The poll below reads these at the moment a change arrives, not when the
    // interval was set up — otherwise it would judge "untouched" against the
    // text as it stood seconds ago.
    const editContentRef = React.useRef(editContent);
    editContentRef.current = editContent;

    // Watch for a change made on the machine — most often the agent rewriting it.
    // With nothing typed here since the last load, there is nothing to lose, so
    // the new text simply replaces the old one. Only when the person has
    // unsaved edits of their own does it wait behind the banner for a choice.
    React.useEffect(() => {
        if (!filePath || pollMs <= 0) return;
        if (state.kind !== 'loaded' || !state.originalHash) return;
        const originalHash = state.originalHash;
        const loadedContent = state.content;

        const interval = setInterval(async () => {
            const content = await readRemoteFile(sessionId, filePath);
            if (content === null) return;
            const hash = await computeSHA256(content);
            if (hash === originalHash) return;
            if (editContentRef.current === loadedContent) {
                setExternalChange(null);
                setState({ kind: 'loaded', content, originalHash: hash });
                setEditContent(content);
            } else {
                setExternalChange(content);
            }
        }, pollMs);

        return () => clearInterval(interval);
    }, [sessionId, filePath, state, pollMs]);

    // A file that did not exist when the panel opened (a canvas the agent has
    // not written yet) is picked up as soon as it appears, instead of leaving
    // the "not created yet" message on screen until the panel is reopened.
    React.useEffect(() => {
        if (!filePath || pollMs <= 0 || state.kind !== 'error') return;
        const interval = setInterval(async () => {
            const content = await readRemoteFile(sessionId, filePath);
            if (content === null) return;
            const hash = await computeSHA256(content);
            setState({ kind: 'loaded', content, originalHash: hash });
            setEditContent(content);
        }, pollMs);
        return () => clearInterval(interval);
    }, [sessionId, filePath, state.kind, pollMs]);

    /** Take the machine's version, discarding local edits. */
    const reload = React.useCallback(() => {
        if (externalChange === null) return;
        const next = externalChange;
        setExternalChange(null);
        (async () => {
            const hash = await computeSHA256(next);
            setState({ kind: 'loaded', content: next, originalHash: hash });
            setEditContent(next);
        })();
    }, [externalChange]);

    const dismissExternalChange = React.useCallback(() => setExternalChange(null), []);

    const save = React.useCallback(async (): Promise<RemoteFileSaveResult> => {
        if (!filePath || state.kind !== 'loaded') return { ok: false, conflict: false };
        setIsSaving(true);
        try {
            const res = await sessionWriteFile(
                sessionId, filePath, encodeStringToBase64(editContent), state.originalHash);

            if (!res.success) {
                const conflict = !!res.error && (res.error.includes('hash') || res.error.includes('mismatch'));
                if (conflict) {
                    // Surface what is actually on the machine so the caller can offer a choice.
                    const serverContent = await readRemoteFile(sessionId, filePath);
                    if (serverContent !== null) setExternalChange(serverContent);
                }
                return { ok: false, conflict, error: res.error };
            }

            setState({ kind: 'loaded', content: editContent, originalHash: res.hash ?? null });
            setExternalChange(null);
            return { ok: true, conflict: false };
        } finally {
            setIsSaving(false);
        }
    }, [sessionId, filePath, editContent, state]);

    /** Write regardless of what is on the machine, re-reading only to satisfy the hash guard. */
    const forceSave = React.useCallback(async (): Promise<RemoteFileSaveResult> => {
        if (!filePath || state.kind !== 'loaded') return { ok: false, conflict: false };
        setIsSaving(true);
        try {
            const serverContent = await readRemoteFile(sessionId, filePath);
            const currentHash = serverContent !== null ? await computeSHA256(serverContent) : undefined;
            const res = await sessionWriteFile(
                sessionId, filePath, encodeStringToBase64(editContent), currentHash);

            if (!res.success) return { ok: false, conflict: false, error: res.error };

            setState({ kind: 'loaded', content: editContent, originalHash: res.hash ?? null });
            setExternalChange(null);
            return { ok: true, conflict: false };
        } finally {
            setIsSaving(false);
        }
    }, [sessionId, filePath, editContent, state]);

    return {
        state,
        editContent,
        setEditContent,
        hasChanges,
        isSaving,
        externalChange,
        reload,
        dismissExternalChange,
        save,
        forceSave,
    };
}
