/**
 * Temporary web-only IME diagnostics for the Korean jamo-decomposition report.
 * Dormant unless the page URL contains `imeDebug` in its query string.
 *
 * When active it captures, at the document level, everything that can explain
 * a broken IME composition — key events (incl. keyCode 229), composition
 * events, beforeinput/input, focus moves, plus stack-traced patches on the
 * APIs that can abort a composition (programmatic value writes,
 * setSelectionRange, focus/blur, preventDefault on input-path events) — and
 * renders them in an on-screen overlay while relaying batches to a local
 * collector at http://127.0.0.1:8899/log (a debugging machine exposes its
 * collector there via an SSH reverse tunnel; for everyone else the fetch
 * fails silently).
 */

let installed = false;

export function installImeDebugIfRequested(): void {
    if (installed) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    if (!window.location.search.includes('imeDebug')) return;
    installed = true;

    const lines: string[] = [];
    let sendCursor = 0;

    const overlay = document.createElement('div');
    overlay.style.cssText = [
        'position:fixed', 'top:0', 'right:0', 'z-index:2147483647',
        'background:rgba(0,0,0,.82)', 'color:#0f0', 'font:10px/1.35 monospace',
        'padding:6px', 'max-height:45vh', 'max-width:44vw', 'overflow:hidden',
        'white-space:pre-wrap', 'word-break:break-all', 'pointer-events:none',
    ].join(';');
    document.body.appendChild(overlay);

    const push = (s: string) => {
        lines.push(`${(performance.now() / 1000).toFixed(3)} ${s}`);
        overlay.textContent = lines.slice(-40).join('\n');
    };

    push(`IMEDEBUG start ua=${navigator.userAgent}`);
    push(`IMEDEBUG url=${window.location.pathname}`);

    setInterval(() => {
        if (sendCursor >= lines.length) return;
        const batch = lines.slice(sendCursor);
        sendCursor = lines.length;
        fetch('http://127.0.0.1:8899/log', { method: 'POST', mode: 'no-cors', body: batch.join('\n') + '\n' })
            .catch(() => { /* collector absent — on-screen overlay still works */ });
    }, 1500);

    const isTextControl = (t: EventTarget | null): t is HTMLTextAreaElement | HTMLInputElement =>
        t instanceof HTMLTextAreaElement || t instanceof HTMLInputElement;

    const describe = (el: Element | null): string => {
        if (!el) return 'null';
        const tag = el.tagName.toLowerCase();
        const ph = el.getAttribute('placeholder');
        return ph ? `${tag}[ph=${ph.slice(0, 14)}]` : `${tag}${el.id ? '#' + el.id : ''}`;
    };

    const stack = (): string => (new Error().stack || '').split('\n').slice(3, 7).join(' <- ');

    for (const t of ['keydown', 'keyup', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'] as const) {
        document.addEventListener(t, (e: Event) => {
            if (!isTextControl(e.target)) return;
            let x = '';
            if (e instanceof KeyboardEvent) {
                x = ` key=${JSON.stringify(e.key)} code=${e.code} kc=${e.keyCode} comp=${e.isComposing}${e.defaultPrevented ? ' PREVENTED' : ''}`;
            } else if (e instanceof CompositionEvent) {
                x = ` data=${JSON.stringify(e.data)}`;
            } else if (e instanceof InputEvent) {
                x = ` it=${e.inputType} data=${JSON.stringify(e.data)}${e.defaultPrevented ? ' PREVENTED' : ''}`;
                if (t === 'input') x += ` value=${JSON.stringify(String((e.target as HTMLTextAreaElement | HTMLInputElement).value).slice(-16))}`;
            }
            push(`${t}[${describe(e.target as Element)}]${x}`);
        }, true);
    }
    for (const t of ['focusin', 'focusout'] as const) {
        document.addEventListener(t, (e: Event) => {
            push(`${t} ${describe(e.target as Element)}`);
        }, true);
    }

    // Stack-traced patches on every API that can abort an in-flight composition.
    const origPrevent = Event.prototype.preventDefault;
    Event.prototype.preventDefault = function (this: Event) {
        if ((this.type === 'keydown' || this.type === 'beforeinput' || this.type.startsWith('composition')) && isTextControl(this.target)) {
            push(`preventDefault(${this.type}) @ ${stack()}`);
        }
        return origPrevent.call(this);
    };

    for (const proto of [HTMLTextAreaElement.prototype, HTMLInputElement.prototype]) {
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc?.get && desc.set) {
            const get = desc.get;
            const set = desc.set;
            Object.defineProperty(proto, 'value', {
                get(this: HTMLElement) { return get.call(this); },
                set(this: HTMLElement, v: unknown) {
                    const active = this === document.activeElement ? 'ACTIVE' : 'bg';
                    push(`PROG value[${active} ${describe(this)}]=${JSON.stringify(String(v).slice(-16))} @ ${stack()}`);
                    return set.call(this, v);
                },
                configurable: true,
            });
        }
        const origSSR = (proto as HTMLTextAreaElement).setSelectionRange;
        (proto as HTMLTextAreaElement).setSelectionRange = function (this: HTMLTextAreaElement, ...a: Parameters<HTMLTextAreaElement['setSelectionRange']>) {
            const active = this === document.activeElement ? 'ACTIVE' : 'bg';
            push(`PROG setSelectionRange[${active} ${describe(this)}](${String(a[0])},${String(a[1])}) @ ${stack()}`);
            return origSSR.apply(this, a);
        };
    }

    const origFocus = HTMLElement.prototype.focus;
    HTMLElement.prototype.focus = function (this: HTMLElement, ...a: Parameters<HTMLElement['focus']>) {
        if (isTextControl(this) || isTextControl(document.activeElement)) {
            push(`PROG focus(${describe(this)}) from=${describe(document.activeElement)} @ ${stack()}`);
        }
        return origFocus.apply(this, a);
    };
    const origBlur = HTMLElement.prototype.blur;
    HTMLElement.prototype.blur = function (this: HTMLElement) {
        if (isTextControl(this)) {
            push(`PROG blur(${describe(this)}) @ ${stack()}`);
        }
        return origBlur.call(this);
    };
}
