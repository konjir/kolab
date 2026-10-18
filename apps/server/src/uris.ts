import { LAYERS, type InboxEvent, type Layer } from '@konjir/types';

/**
 * Resources an agent subscribes to. Kolab signals them; their contents are read, never pushed.
 * Each is one kolab's (D50): a change in one kolab signals only that kolab's resources, and a
 * session may subscribe only to its own kolab's (ListenScope), so no kolab hears another's.
 */
export const inboxUri = (kolab: string, layer: Layer) => `konjir://inbox/${encodeURIComponent(kolab)}/${layer}`;
export const answersUri = (kolab: string, actor: string) => `konjir://answers/${encodeURIComponent(kolab)}/${encodeURIComponent(actor)}`;
export const uriOf = (e: InboxEvent) => e.inbox === 'layer' ? inboxUri(e.kolab, e.layer) : answersUri(e.kolab, e.actor);

/** Every resource a session of `actor` in `kolab` may subscribe to: each layer's inbox there, and its own answers there. */
export const subscribableBy = (kolab: string, actor: string) => [...LAYERS.map((l) => inboxUri(kolab, l)), answersUri(kolab, actor)];
