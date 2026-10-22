import { useEffect, useRef } from 'react';
import type { WebEvent } from '@konjir/types';
import { backoff, clock } from './api.js';

export interface LiveHandlers {
  /** Something changed: re-read what the page shows. */
  onChange(e: WebEvent): void;
  /** Kolab said the session ended (`ended`). */
  onEnded(): void;
  /**
   * The stream closed for good: refused, or Kolab away behind its proxy (a 502 while it restarts).
   * Resolves whether the session lives on, when the stream is opened again.
   */
  onDropped(): Promise<boolean>;
  /** The stream is back after a break, in which signals may have been missed. */
  onResumed(): void;
}

/**
 * Keeps the page live (API8): one server-sent event stream, GET /api/events. Each signal is
 * only that something changed, so `onChange` re-reads what the page shows. Only Kolab's `ended`
 * ends the session here. The browser reconnects a dropped stream by itself; one it gives up on (a
 * reply that isn't a stream, such as a proxy's 502 while Kolab restarts) is not taken for the
 * session's end: `onDropped` asks Kolab, and the stream opens again if the session lives, after a backoff.
 */
export function useLive(enabled: boolean, handlers: LiveHandlers) {
  const current = useRef(handlers);
  current.current = handlers;
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    let gone = false;
    let source: EventSource | undefined;
    let opened = 0;
    let drops = 0;
    const open = () => {
      if (gone) return;
      const s = source = new EventSource('/api/events');
      s.onmessage = (m) => {
        let e: WebEvent;
        try { e = JSON.parse(m.data); } catch { return; }
        if (e.type === 'ended') { gone = true; s.close(); current.current.onEnded(); return; }
        if (e.type === 'ready') { drops = 0; if (opened++ > 0) current.current.onResumed(); return; }
        current.current.onChange(e);
      };
      s.onerror = () => {
        if (s.readyState !== EventSource.CLOSED || gone) return;
        // Opened again after a backoff, so a stream refused again and again (Kolab still starting) isn't a busy loop.
        void current.current.onDropped().then(async (live) => { if (live) { await clock.wait(backoff(drops++)); open(); } }, () => undefined);
      };
    };
    open();
    return () => { gone = true; source?.close(); };
  }, [enabled]);
}
