import * as z from 'zod/v4';

/**
 * A verb's arguments, or one object inside them (W5.7): strict, so an argument Kolab doesn't know
 * is refused, never dropped, and the refusal names it and the arguments that are taken. `hint`
 * adds a sentence for a likely mistake, by the unknown key, e.g. create_node's `name`, which is `id`.
 */
export function args<T extends z.core.$ZodLooseShape>(shape: T, hints: Record<string, string> = {}) {
  const accepted = Object.keys(shape);
  return z.strictObject(shape, {
    error: (iss) => {
      if (iss.code !== 'unrecognized_keys') return undefined;
      const keys = (iss as { keys: string[] }).keys;
      const extra = keys.map((k) => hints[k]).filter(Boolean);
      return [
        `unknown argument${keys.length > 1 ? 's' : ''} ${keys.join(', ')}: ${accepted.length ? `it takes ${accepted.join(', ')}` : 'it takes no arguments'}`,
        ...extra,
      ].join('. ');
    },
  });
}
