import { useState } from 'react';
import type { WebMark, WebMe, WebQuery } from '@konjir/types';
import { Addr, Diff, Pill } from './bits.js';
import { addr, ago } from '../util.js';
import { api as call } from '../api.js';

export interface Act { run(what: () => Promise<unknown>, done: string): Promise<boolean> }

const REASON: Record<string, string> = {
  changed: 'stale', fuzzy_reanchor: 'stale', orphaned: 'orphaned', override_stale: 'stale', override_orphaned: 'orphaned',
  upstream_dirty: 'stale', rebase_failed: 'boundary', review_failed: 'boundary', role_boundary: 'boundary', query_answered: 'answered', ruled: 'ruled',
};
export const markWord = (m: WebMark) => REASON[m.reason] ?? m.reason;

/** A mark beside its element, with what changed and what settles it (LNK6, OVR8). */
export function MarkBox({ mark: m, me, act, onRevise }: { mark: WebMark; me: WebMe; act: Act; onRevise?: () => void }) {
  const mine = me.layer === m.layer;
  const [amending, setAmending] = useState(false);
  const [text, setText] = useState(m.override?.mine ?? '');
  const tone = markWord(m) === 'orphaned' || markWord(m) === 'boundary' ? 'boundary' : 'stale';
  const clear = () => act.run(() => api('marks', m.id, 'clear', {}), 'Cleared: it still holds');
  const resolve = (resolution: string, t?: string) => act.run(() => api('marks', m.id, 'resolve', { resolution, text: t }), 'Resolved. It is precedent now for the same change elsewhere.');
  const waiting = <span className="why-not">Waiting on the {m.layer} layer to settle it.</span>;
  return (
    <div className={`markbox${tone === 'boundary' ? ' boundary' : ''}`} data-mark={m.id}>
      <div className="head">
        <Pill tone={tone}>{markWord(m)}</Pill>
        {m.target
          ? <span><Addr>{addr(m.target.node, null, m.target.element)}</Addr> {m.target.after === null ? `is gone in version ${m.target.now}` : `changed in version ${m.target.now}`}. This element was written against version {m.target.pinned}.</span>
          : m.override
            ? <span>The parent {m.override.parent_now === null ? 'removed' : 'changed'} <Addr>{m.override.element}</Addr>, which this variant overrides.</span>
            : <span>{m.because}</span>}
      </div>
      {m.target && m.target.before !== null && <div className="diff"><Diff before={m.target.before} after={m.target.after ?? ''} /></div>}
      {m.override && (
        <div className="diff">
          <div className="why-not">Parent, then and now</div>
          <Diff before={m.override.parent_before ?? ''} after={m.override.parent_now ?? ''} />
          <div className="why-not" style={{ marginTop: 6 }}>This variant says</div>
          <span>{m.override.mine ?? '(removed here)'}</span>
        </div>
      )}
      <div className="edit-row">
        {!mine ? waiting : m.override ? (
          amending ? (
            <>
              <label className="sr-only" htmlFor={`amend-${m.id}`}>Amended text</label>
              <textarea id={`amend-${m.id}`} value={text} onChange={(e) => setText(e.target.value)} />
              <button type="button" className="btn primary" disabled={!text.trim()} onClick={() => resolve('amend', text)}>Amend</button>
              <button type="button" className="btn quiet" onClick={() => setAmending(false)}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => resolve('reaffirm')}>Keep ours</button>
              <button type="button" className="btn" onClick={() => resolve('adopt_parent')}>{m.override.parent_now === null ? 'Drop it' : 'Adopt the parent\'s'}</button>
              <button type="button" className="btn" onClick={() => setAmending(true)}>Amend</button>
              <span className="why-not">Your ruling becomes precedent for the same change.</span>
            </>
          )
        ) : m.reason === 'ruled' ? (
          <>
            {onRevise && <button type="button" className="btn" onClick={onRevise}>Revise {m.element ?? m.node}</button>}
            <span className="why-not">A ruling changed the intent. Amend {m.element ?? 'it'} to say what the ruling says and commit it: that version settles this. It can’t be cleared by hand.</span>
          </>
        ) : m.reason === 'rebase_failed' || m.reason === 'role_boundary' ? (
          <span className="why-not">{m.next || 'Answer its question to settle it.'}</span>
        ) : (
          <>
            {m.target?.after === null
              ? <span className="why-not">What it relied on is gone: re-link it, or revise it.</span>
              : <button type="button" className="btn" onClick={clear}>Still holds</button>}
            {onRevise && <button type="button" className="btn" onClick={onRevise}>Revise {m.element}</button>}
            <span className="why-not">Check it against the new text: clear it if it still holds, or revise it.</span>
          </>
        )}
      </div>
    </div>
  );
}

/** A question or a note beside what it is about (Q5), with the answer, or the form to give it. */
export function QueryBox({ query: q, me, act, readOnly }: { query: WebQuery; me: WebMe; act: Act; readOnly?: boolean }) {
  const [answer, setAnswer] = useState('');
  const owner = !readOnly && q.layer === me.layer && me.access.layers.includes(q.layer);
  const settledByMark = q.mark !== null && q.mark_reason !== 'role_boundary';
  return (
    <div className="qbox" data-query={q.id}>
      <div className="by">
        {q.state === 'answered' ? <Pill tone="clean">answered</Pill> : q.mark_reason === 'role_boundary' ? <Pill tone="boundary">boundary</Pill> : <Pill tone="question">{q.kind === 'note' ? 'note' : 'asks'}</Pill>}
        {' '}{q.raised_by ?? 'Kolab'} {q.kind === 'note' ? 'noted' : 'asked'} {ago(q.at)} on <Addr>{q.address}</Addr>
      </div>
      {q.quote && <div className="why-not">“{q.quote}”</div>}
      <blockquote>{q.question}</blockquote>
      {q.state === 'answered' ? (
        <div className="a"><span className="why-not">{q.answered_by} answered</span><br />{q.answer}</div>
      ) : settledByMark ? (
        <span className="why-not">{q.mark_reason === 'ruled' ? 'It settles when a version amends the element.' : 'It settles with its mark.'}</span>
      ) : readOnly ? (
        <span className="why-not">Open, in its own kolab.</span>
      ) : owner ? (
        <form className="ask-form" onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => answerQuery(q.id, answer), 'Answered')) setAnswer(''); }}>
          <label className="why-not" htmlFor={`ans-${q.id}`}>{q.kind === 'note' ? 'Reply. A reply to a note marks nothing.' : 'Answer. If it settles intent, amend the spec too, so everyone who depends on it hears.'}</label>
          <textarea id={`ans-${q.id}`} required value={answer} onChange={(e) => setAnswer(e.target.value)} />
          <div className="edit-row"><button type="submit" className="btn primary" disabled={!answer.trim()}>{q.kind === 'note' ? 'Reply' : 'Answer'}</button></div>
        </form>
      ) : (
        <span className="why-not">Waiting on the {q.layer} layer.</span>
      )}
    </div>
  );
}

const api = (kind: 'marks', id: string, verb: string, body: unknown) => call(`${kind}/${encodeURIComponent(id)}/${verb}`, body);
export const answerQuery = (id: string, answer: string) => call(`queries/${encodeURIComponent(id)}/answer`, { answer });
