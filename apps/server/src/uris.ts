import type { InboxEvent, Layer } from '@konjir/types';

/** Resources an agent subscribes to. Kolab signals them; their contents are read, never pushed. */
export const inboxUri = (layer: Layer) => `konjir://inbox/${layer}`;
export const answersUri = (actor: string) => `konjir://answers/${encodeURIComponent(actor)}`;
export const uriOf = (e: InboxEvent) => e.inbox === 'layer' ? inboxUri(e.layer) : answersUri(e.actor);
