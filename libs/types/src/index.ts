/**
 * Types and constants shared by Kolab's engine, server, CLI and web interface.
 */

export type Role = 'product' | 'engineer';
export type Layer = 'functional' | 'technical';
export type Kind =
  | 'functional_spec' | 'prototype' | 'technical_binding' | 'wbs' | 'work_package' | 'implementation';

export const LAYER_OF_KIND: Record<Kind, Layer> = {
  functional_spec: 'functional',
  prototype: 'functional',
  technical_binding: 'technical',
  wbs: 'technical',
  work_package: 'technical',
  implementation: 'technical',
};
export const LAYER_OF_ROLE: Record<Role, Layer> = { product: 'functional', engineer: 'technical' };

export interface ElementInput { id?: string; text: string; parent?: string }
export interface DeltaInput { kind: 'add' | 'override' | 'remove'; element: string; text?: string; parent?: string }

export interface ElementRow {
  element_id: string;
  parent_element_id: string | null;
  ord: number;
  text: string;
  fingerprint: string;
}
export interface VersionRow {
  id: string; node_id: string; seq: number; parent_version_id: string | null;
  layer: Layer; state: 'drafted' | 'committed' | 'rejected'; actor_id: string; active_role: string;
}

export interface MarkRow {
  id: string; version_id: string; element_id: string | null; edge_id: string | null;
  delta_id: string | null; triggered_by: string; note: string | null;
  reason: string; state: 'open' | 'cleared'; cleared_by: string | null;
}

/**
 * What a reviewer can report. A contradiction rejects the version. A layer
 * leak (implementation in a functional spec, or a binding that changes
 * behavior) does not: per decision 3 it commits and becomes a question to the
 * layer that owns the answer.
 */
export interface Finding {
  kind: 'contradiction' | 'layer_leak';
  elements: string[];
  explanation: string;
}
export type ReviewVerdict = { ok: boolean; note?: string; findings?: Finding[] };
export type GateResult = ReviewVerdict & { version: string; retryable?: boolean };
export interface ReviewContext {
  version: VersionRow;
  elements: ElementRow[];
  node: { id: string; kind: Kind; layer: Layer; title: string };
  /** For each link out of this version: which element relies on what, and that target's text. */
  upstream: { element: string | null; target: string; text: string | null }[];
}
export type Reviewer = (ctx: ReviewContext) => ReviewVerdict | Promise<ReviewVerdict>;

export type Resolution =
  | { status: 'ok'; content: string; fingerprint: string }
  | { status: 'fuzzy'; content: string; fingerprint: string }
  | { status: 'orphan' };

export type OverrideResolution = 'reaffirm' | 'adopt_parent' | 'amend';

/**
 * Something an agent should look at: a layer's work queue (open questions,
 * notes and marks it owns) or an actor's answers (replies to what they raised).
 */
export type KolabEvent = { inbox: 'layer'; layer: Layer } | { inbox: 'actor'; actor: string };

export interface Query {
  id: string; kind: 'question' | 'note'; address: string; question: string; state: string;
  answer: string | null; answered_by: string | null; raised_by: string | null;
  from: string | null; mark: string | null;
}
