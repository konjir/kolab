import type { ReactNode } from 'react';
import { wordDiff } from '../util.js';

const glyph = {
  clean: <circle cx="5" cy="5" r="4" />,
  stale: <><circle cx="5" cy="5" r="4" /><path d="M5 1a4 4 0 0 1 0 8Z" fill="currentColor" stroke="none" /></>,
  question: <><path d="M3.2 3.6a1.9 1.9 0 1 1 2.6 1.7c-.5.3-.8.6-.8 1.2" /><circle cx="5" cy="8.4" r=".6" fill="currentColor" stroke="none" /></>,
  boundary: <><circle cx="5" cy="5" r="4" /><path d="M2.2 7.8L7.8 2.2" /></>,
};

/** A status: its glyph and its word, never color alone (design system: status marks). */
export function Pill({ tone, children }: { tone: keyof typeof glyph; children: ReactNode }) {
  return (
    <span className={`pill ${tone}`}>
      <span className="g"><svg viewBox="0 0 10 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">{glyph[tone]}</svg></span>
      {children}
    </span>
  );
}

/** Words removed and added between two texts. */
export function Diff({ before, after }: { before: string; after: string }) {
  return (
    <>{wordDiff(before, after).map((p, i) => p.kind === 'same' ? <span key={i}>{p.text}</span> : p.kind === 'del' ? <del key={i}>{p.text}</del> : <ins key={i}>{p.text}</ins>)}</>
  );
}

export const Addr = ({ children }: { children: ReactNode }) => <span className="addr">{children}</span>;

/** The wordmark: lowercase konjir, the sun as its o and the crescent moon as its j. */
export function Wordmark() {
  return (
    <svg viewBox="0 0 122 56" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 6V40M16 21L4 32M8.5 28.5L17 40" /><path d="M54 20V40M54 28a8 8 0 0 1 16 0V40" /><path d="M98 20V40" /><path d="M107 20V40M107 29a9 9 0 0 1 9 -9" />
      </g>
      <circle cx="36" cy="30" r="11.7" fill="var(--sun)" />
      <path d="M84.60 18.60 A19.68 19.68 0 0 1 76.40 52.40 A29.60 29.60 0 0 0 84.60 18.60Z" fill="var(--moon)" stroke="var(--moon)" strokeWidth="0.6" strokeLinejoin="round" />
    </svg>
  );
}
