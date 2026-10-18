import { useEffect, useRef } from 'react';
import type { WebEvent } from '@konjir/types';

/**
 * Keeps the page live (API8): one server-sent event stream, GET /api/events. Each signal is
 * only that something changed, so `onChange` re-reads what the page shows. `onEnded` runs when
 * the session ends. The browser reconnects a dropped stream by itself; a stream that can't open
 * at all (signed out) is closed.
 */
export function useLive(enabled: boolean, onChange: (e: WebEvent) => void, onEnded: () => void) {
  const handlers = useRef({ onChange, onEnded });
  handlers.current = { onChange, onEnded };
  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const source = new EventSource('/api/events');
    source.onmessage = (m) => {
      let e: WebEvent;
      try { e = JSON.parse(m.data); } catch { return; }
      if (e.type === 'ended') { source.close(); handlers.current.onEnded(); return; }
      if (e.type === 'changed') handlers.current.onChange(e);
    };
    source.onerror = () => { if (source.readyState === EventSource.CLOSED) handlers.current.onEnded(); };
    return () => source.close();
  }, [enabled]);
}
