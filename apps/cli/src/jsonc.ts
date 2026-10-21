/**
 * JSON with comments, as OpenCode reads its configuration: `//` and block comments, and trailing
 * commas in objects and arrays. Parsed to a tree that keeps each value's offset and length in the
 * text, so `konjir connect` can edit the text in place and keep everything else in it as it was.
 * Small on purpose: the published konjir bundles nothing it doesn't need.
 */

export interface JsonNode {
  type: 'object' | 'array' | 'property' | 'string' | 'number' | 'boolean' | 'null';
  offset: number;
  length: number;
  /** A scalar's value; a property's key, as its first child is. */
  value?: unknown;
  /** An object's properties; an array's items; a property's key and value. */
  children?: JsonNode[];
}

export class JsoncError extends Error {
  constructor(readonly what: string, readonly offset: number, text: string) {
    super(`${what} on line ${text.slice(0, offset).split('\n').length}`);
  }
}

type Token = { kind: '{' | '}' | '[' | ']' | ':' | ',' | 'string' | 'number' | 'word' | 'eof'; offset: number; end: number; value?: unknown };

/** The tokens of `text` from `start`, comments and whitespace skipped. */
export function* tokens(text: string, start = 0, end = text.length): Generator<Token> {
  let i = start;
  while (i < end) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '﻿') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < end && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close < 0 || close + 2 > end) throw new JsoncError('an unclosed comment', i, text);
      i = close + 2;
      continue;
    }
    if ('{}[]:,'.includes(c)) { yield { kind: c as Token['kind'], offset: i, end: i + 1 }; i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < end && text[j] !== '"') { if (text[j] === '\\') j++; if (text[j] === '\n') break; j++; }
      if (j >= end || text[j] !== '"') throw new JsoncError('an unclosed string', i, text);
      let value: string;
      try { value = JSON.parse(text.slice(i, j + 1)) as string; } catch { throw new JsoncError('a malformed string', i, text); }
      yield { kind: 'string', offset: i, end: j + 1, value };
      i = j + 1;
      continue;
    }
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, end));
    if (m && m[0]) { yield { kind: 'number', offset: i, end: i + m[0].length, value: Number(m[0]) }; i += m[0].length; continue; }
    const w = /^(true|false|null)\b/.exec(text.slice(i, end));
    if (w) { yield { kind: 'word', offset: i, end: i + w[0].length, value: w[0] === 'null' ? null : w[0] === 'true' }; i += w[0].length; continue; }
    throw new JsoncError(`an unexpected ${JSON.stringify(c)}`, i, text);
  }
  yield { kind: 'eof', offset: end, end };
}

/** Parses `text` to its tree, or throws a JsoncError saying what is wrong, and on which line. */
export function parseTree(text: string): JsonNode {
  const it = tokens(text);
  let current = it.next().value as Token;
  const next = () => { current = it.next().value as Token; };
  /** The token at hand, read afresh each time (next() moves it). */
  const tok = (): Token => current;
  const value = (): JsonNode => {
    const start = tok();
    if (start.kind === 'string' || start.kind === 'number') { next(); return { type: start.kind, offset: start.offset, length: start.end - start.offset, value: start.value }; }
    if (tok().kind === 'word') { next(); return { type: start.value === null ? 'null' : 'boolean', offset: start.offset, length: start.end - start.offset, value: start.value }; }
    if (tok().kind === '{' || tok().kind === '[') {
      const object = tok().kind === '{';
      const close = object ? '}' : ']';
      const children: JsonNode[] = [];
      next();
      while (tok().kind !== close) {
        if (object) {
          if (tok().kind !== 'string') throw new JsoncError('a property name expected', tok().offset, text);
          const key: JsonNode = { type: 'string', offset: tok().offset, length: tok().end - tok().offset, value: tok().value };
          next();
          if (tok().kind !== ':') throw new JsoncError('a colon expected', tok().offset, text);
          next();
          const v = value();
          children.push({ type: 'property', offset: key.offset, length: v.offset + v.length - key.offset, value: key.value, children: [key, v] });
        } else {
          children.push(value());
        }
        if (tok().kind === ',') { next(); continue; }
        if (tok().kind !== close) throw new JsoncError(`a comma or ${close} expected`, tok().offset, text);
      }
      const end = tok().end;
      next();
      return { type: object ? 'object' : 'array', offset: start.offset, length: end - start.offset, children };
    }
    throw new JsoncError(tok().kind === 'eof' ? 'an unexpected end' : 'a value expected', tok().offset, text);
  };
  const root = value();
  if (tok().kind !== 'eof') throw new JsoncError('an end expected', tok().offset, text);
  return root;
}

/** A node's value as plain JSON. */
export function valueOf(n: JsonNode): unknown {
  if (n.type === 'object') return Object.fromEntries((n.children ?? []).map((p) => [p.value as string, valueOf(p.children![1])]));
  if (n.type === 'array') return (n.children ?? []).map(valueOf);
  return n.value;
}

/** The value of an object's member `key`, if it has one (the last, if it is there twice, as JSON.parse takes it). */
export const member = (obj: JsonNode, key: string): JsonNode | undefined =>
  obj.type === 'object' ? obj.children?.filter((p) => p.value === key).at(-1)?.children?.[1] : undefined;
