import { useEffect, useState } from 'react';
import type { QueryKind, WebElement, WebLink, WebMe, WebNodeView, WebOutcome } from '@konjir/types';
import { api } from '../api.js';
import { addr, ago, nextElementId } from '../util.js';
import { Addr, Diff, Pill } from './bits.js';
import { MarkBox, QueryBox, markWord, type Act } from './Marks.js';

const KIND_WORD: Record<string, string> = {
  functional_spec: 'Functional spec', prototype: 'Prototype', technical_binding: 'Technical binding',
  wbs: 'Plan', work_package: 'Work package', implementation: 'Implementation',
};

/** Edits not yet submitted: kept in the page, per node, until submitted or discarded. */
interface Draft { changes: Record<string, string>; added: { id: string; text: string }[]; removed: string[]; unlinked: string[]; replaces?: number }
const EMPTY: Draft = { changes: {}, added: [], removed: [], unlinked: [] };

export interface NodeViewProps {
  me: WebMe; name: string; version?: number; tick: number; act: Act;
  go(route: string): void;
  /** Opens a version of this node (undefined for the latest). */
  read(version?: number): void;
  focus?: string;
}

/**
 * One node, as the prototype's Spec and Binding pages show it: its elements, each with its links,
 * marks, questions and notes beside it; its versions; edits kept as a draft until submitted for
 * review; and the review of a version in review, for whoever is asked to give it.
 */
export function NodeView({ me, name, version, tick, act, go, read, focus }: NodeViewProps) {
  const [view, setView] = useState<WebNodeView>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string>();
  const [asking, setAsking] = useState<string | null>();
  const [notice, setNotice] = useState<WebOutcome & { node: string }>();

  useEffect(() => {
    let live = true;
    api<WebNodeView>(`nodes/${encodeURIComponent(name)}${version ? `?version=${version}` : ''}`)
      .then((v) => { if (live) { setView(v); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [name, version, tick]);
  useEffect(() => { setDraft(EMPTY); setEditing(undefined); setAsking(undefined); setNotice(undefined); }, [name]);
  useEffect(() => {
    if (!focus || !view) return;
    document.getElementById(`el-${focus}`)?.scrollIntoView({ block: 'center' });
  }, [focus, view]);

  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!view) return <p className="empty">Reading {addr(name)}…</p>;

  const latest = view.node.latest;
  const reading = view.reading;
  const isLatest = !!reading && reading.seq === latest;
  const inReview = view.in_review[0];
  const mineInReview = view.in_review.find((r) => r.author === me.actor);
  const writable = view.can_write && (isLatest || latest === null) && !mineInReview;
  const whyNot = !view.can_write
    ? (view.node.layer === 'functional' ? 'Engineers can’t change intent. Ask the spec instead.' : 'Product can’t change implementation. Ask the binding instead.')
    : mineInReview ? `Version ${mineInReview.seq} is in review. Edits wait until it is decided.` : '';
  const changes = Object.keys(draft.changes).length + draft.added.length + draft.removed.length + draft.unlinked.length;
  const compared = view.compared_with && (!isLatest || reading?.state !== 'committed')
    ? new Map(view.compared_with.elements.map((e) => [e.id, e.text])) : undefined;

  const save = (id: string, text: string) => {
    setDraft((d) => {
      const added = d.added.find((a) => a.id === id);
      if (added) return { ...d, added: d.added.map((a) => (a.id === id ? { id, text } : a)) };
      const original = view.elements.find((e) => e.id === id)?.text;
      const next = { ...d.changes };
      if (text === original) delete next[id]; else next[id] = text;
      return { ...d, changes: next };
    });
    setEditing(undefined);
  };
  const add = () => {
    const ids = [...view.elements.map((e) => e.id), ...draft.added.map((a) => a.id)];
    const id = nextElementId(ids, view.node.layer === 'functional' ? 'R' : 'B');
    setDraft((d) => ({ ...d, added: [...d.added, { id, text: '' }] }));
    setEditing(id);
  };
  const remove = (id: string) => {
    setDraft((d) => d.added.some((a) => a.id === id)
      ? { ...d, added: d.added.filter((a) => a.id !== id) }
      : { ...d, removed: [...d.removed, id], changes: Object.fromEntries(Object.entries(d.changes).filter(([k]) => k !== id)) });
    setEditing(undefined);
  };
  const submit = async () => {
    const body = {
      base: view.node.latest,
      changes: [
        ...Object.entries(draft.changes).map(([element, text]) => ({ kind: 'override' as const, element, text })),
        ...draft.added.map((a) => ({ kind: 'add' as const, element: a.id, text: a.text })),
        ...draft.removed.map((element) => ({ kind: 'remove' as const, element })),
      ],
      ...(draft.unlinked.length ? { unlink: draft.unlinked } : {}),
      replaces: draft.replaces,
    };
    let out: WebOutcome | undefined;
    const ok = await act.run(async () => { out = await api<WebOutcome>(`nodes/${encodeURIComponent(name)}/submit`, body); },
      '');
    if (!ok || !out) return;
    setNotice({ ...out, node: name });
    if (out.committed || out.in_review) { setDraft(EMPTY); read(undefined); }
    window.scrollTo?.({ top: 0 });
  };
  const verdict = async (seq: number, verdict: 'approve' | 'request_changes', note?: string) => {
    let out: WebOutcome | undefined;
    if (await act.run(async () => { out = await api<WebOutcome>(`nodes/${encodeURIComponent(name)}/versions/${seq}/review`, { verdict, note }); },
      verdict === 'approve' ? 'Approved' : 'Changes requested. The draft is back with its author.')) {
      if (out) setNotice({ ...out, node: name });
      read(undefined);
    }
  };
  const versionVerb = (seq: number, verb: 'resubmit' | 'abandon', done: string) =>
    act.run(async () => {
      const out = await api<WebOutcome | { state: string }>(`nodes/${encodeURIComponent(name)}/versions/${seq}/${verb}`, {});
      if ('seq' in out) setNotice({ ...out, node: name });
    }, done);

  const rows = reading ? [...view.elements, ...(isLatest || latest === null ? draft.added.map(asElement(name)) : [])] : draft.added.map(asElement(name));
  return (
    <>
      {notice && <Notice outcome={notice} onDismiss={() => setNotice(undefined)} />}
      <section aria-labelledby="doc-title">
        <div className="doc-head">
          <span className="kind">{KIND_WORD[view.node.kind] ?? view.node.kind}</span>
          <h2 id="doc-title">{view.node.title}</h2>
          <Addr>{addr(name, reading?.seq)}</Addr>
          <div className="doc-meta">
            {reading
              ? <>Version {reading.seq}{reading.state === 'committed' ? `, committed by ${reading.author}` : reading.state === 'in_review' ? `, in review, by ${reading.author}` : `, your draft`} {ago(reading.at)}{reading.note ? ` · ${reading.note}` : ''}</>
              : 'Nothing committed yet.'}
            {reading && !isLatest && reading.state === 'committed' && <span className="reading-old"> · An older version. Read only.</span>}
            {view.versions.length > 0 && (
              <div className="versions" role="group" aria-label="Versions">
                {view.versions.map((v) => (
                  <button key={v.seq} type="button" aria-pressed={v.seq === reading?.seq} onClick={() => read(v.seq === latest ? undefined : v.seq)}
                    title={v.state === 'committed' ? `Committed by ${v.author}` : v.state === 'in_review' ? `In review, by ${v.author}` : 'Your draft'}>
                    v{v.seq}{v.state === 'in_review' ? ' · in review' : v.state === 'drafted' ? ' · draft' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {view.queries.length > 0 && <div className="flags" style={{ marginTop: 12 }}>{view.queries.map((q) => <QueryBox key={q.id} query={q} me={me} act={act} />)}</div>}
      </section>

      <ol className="els" aria-label="Elements">
        {rows.length ? rows.map((e) => (
          <ElementRow key={e.id} name={name} element={e} me={me} act={act} go={go}
            seq={reading?.seq ?? null} live={isLatest} writable={writable} focus={focus === `${name}#${e.id}`}
            text={draft.changes[e.id] ?? draft.added.find((a) => a.id === e.id)?.text ?? e.text}
            removed={draft.removed.includes(e.id)} drafted={e.id in draft.changes || draft.added.some((a) => a.id === e.id)}
            before={compared ? compared.get(e.id) ?? '' : undefined}
            editing={editing === e.id} asking={asking === e.id}
            onEdit={() => { setEditing(e.id); setAsking(undefined); }} onCancel={() => { setEditing(undefined); setAsking(undefined); }}
            onSave={(t) => save(e.id, t)} onRemove={() => remove(e.id)} unlinked={draft.unlinked}
            onUnlink={(edge) => setDraft((d) => ({ ...d, unlinked: d.unlinked.includes(edge) ? d.unlinked.filter((x) => x !== edge) : [...d.unlinked, edge] }))} onAsk={() => { setAsking(e.id); setEditing(undefined); }} />
        )) : (
          <li className="empty">{view.node.layer === 'functional' ? 'No requirements yet.' : 'No elements yet.'} {writable ? 'Add the first one below.' : ''}</li>
        )}
      </ol>
      {writable && <div className="edit-row"><button type="button" className="btn" onClick={add}>Add {view.node.layer === 'functional' ? 'a requirement' : 'an element'}</button>
        <button type="button" className="btn quiet" onClick={() => setAsking(asking === null ? undefined : null)}>Ask about {addr(name)}</button></div>}
      {!writable && whyNot && isLatest && <p className="why-not">{whyNot}</p>}
      {asking === null && <AskForm name={name} seq={reading?.seq} element={undefined} layer={view.node.layer} act={act} onDone={() => setAsking(undefined)} />}

      {view.drafts.map((d) => (
        <div key={d.seq} className="notice" role="region" aria-label={`Your draft ${d.seq}`}>
          <h2><span className="drafted">Your draft</span> <Addr>{addr(name, d.seq)}</Addr></h2>
          <p>{d.note ? `It came back: ${d.note}` : 'Not submitted yet.'} Resubmit it as it is, or abandon it and edit afresh.</p>
          <div className="edit-row">
            <button type="button" className="btn quiet" onClick={() => read(d.seq)}>Read it</button>
            <button type="button" className="btn" onClick={() => versionVerb(d.seq, 'abandon', `Abandoned ${addr(name, d.seq)}`)}>Abandon</button>
            <button type="button" className="btn primary" onClick={() => versionVerb(d.seq, 'resubmit', `Resubmitted ${addr(name, d.seq)}`)}>Resubmit</button>
          </div>
        </div>
      ))}

      {inReview && <ReviewBar name={name} review={inReview} mine={inReview.author === me.actor} reading={reading?.seq}
        read={read} onVerdict={verdict} onAbandon={() => versionVerb(inReview.seq, 'abandon', `Abandoned ${addr(name, inReview.seq)}`)} />}
      {!inReview && changes > 0 && (
        <div className="draftbar" role="region" aria-label="Draft">
          <span className="what"><span className="drafted">Draft</span> · {changes} change{changes > 1 ? 's' : ''} to {addr(name)}. Kolab checks its structure, then another writer of the {view.node.layer} layer reviews it. Nothing changes for anyone until it’s approved.</span>
          <button type="button" className="btn quiet" onClick={() => { setDraft(EMPTY); setEditing(undefined); }}>Discard</button>
          <button type="button" className="btn primary" onClick={submit}>Submit for review</button>
        </div>
      )}
    </>
  );
}

const asElement = (name: string) => (a: { id: string; text: string }): WebElement =>
  ({ id: a.id, parent: null, text: a.text, address: addr(name, null, a.id), queries: [], relies_on: [], relied_on_by: [], marks: [] });

interface RowProps {
  name: string; element: WebElement; me: WebMe; act: Act; go(route: string): void;
  seq: number | null; live: boolean; writable: boolean; focus: boolean;
  text: string; removed: boolean; drafted: boolean; before?: string; editing: boolean; asking: boolean;
  onEdit(): void; onCancel(): void; onSave(text: string): void; onRemove(): void; onAsk(): void;
  /** Links dropped in the draft (konjir_draft's unlink), and toggling one. */
  unlinked: string[]; onUnlink(edge: string): void;
}

function ElementRow(p: RowProps) {
  const e = p.element;
  const [value, setValue] = useState(p.text);
  useEffect(() => { if (p.editing) setValue(p.text); }, [p.editing, p.text]);
  const open = e.queries.filter((q) => q.state === 'open');
  const status = e.marks[0] ? <Pill tone={markWord(e.marks[0]) === 'orphaned' ? 'boundary' : 'stale'}>{markWord(e.marks[0])}</Pill>
    : e.relies_on.length ? <Pill tone="clean">holds</Pill> : null;
  const chip = (l: WebLink, side: 'target' | 'source') => {
    const end = l[side];
    const n = end.node, el = end.element;
    return (
      <button key={l.edge} type="button" className={`chip${l.mark ? ' stale' : ''}`} onClick={() => p.go(`node/${n}${el ? `#${el}` : ''}`)}
        title={side === 'target' ? `Pinned to ${addr(n, end.seq, el)}${l.target.latest && l.target.latest !== end.seq ? `; now at v${l.target.latest}` : ''}` : addr(n, end.seq, el)}>
        {n === p.name ? '' : `${n}`}{el ? `${n === p.name ? '' : '#'}${el}` : ''}{side === 'target' ? <> <span aria-hidden="true">@</span>{end.seq}</> : null}
      </button>
    );
  };
  return (
    <li className={`el${p.focus ? ' target' : ''}`} id={`el-${p.name}#${e.id}`}>
      <div className="id">
        <button type="button" title={`Copy ${e.address}`} onClick={() => copy(e.address, p.act)}>{e.id}</button>
        {(p.drafted || p.removed) && <div className="drafted">{p.removed ? 'removed' : 'draft'}</div>}
      </div>
      <div className="text">
        {p.editing ? (
          <>
            <label className="why-not" htmlFor={`ed-${e.id}`}>Edit {e.id}</label>
            <textarea id={`ed-${e.id}`} value={value} autoFocus onChange={(ev) => setValue(ev.target.value)} />
            <div className="edit-row">
              <button type="button" className="btn primary" onClick={() => p.onSave(value)}>Keep in draft</button>
              <button type="button" className="btn quiet" onClick={p.onCancel}>Cancel</button>
              <button type="button" className="btn quiet" onClick={p.onRemove}>Remove {e.id}</button>
            </div>
          </>
        ) : (
          <p style={p.removed ? { textDecoration: 'line-through' } : undefined}>{p.before !== undefined && p.before !== p.text ? <Diff before={p.before} after={p.text} /> : p.text}</p>
        )}
        {e.relies_on.length > 0 && <div className="links">relies on {e.relies_on.map((l) => (
          <span key={l.edge} style={p.unlinked.includes(l.edge) ? { textDecoration: 'line-through' } : undefined}>
            {chip(l, 'target')}
            {p.writable && <button type="button" className="btn quiet" style={{ ['--kb-h' as string]: '24px', fontSize: 12 }}
              aria-label={`${p.unlinked.includes(l.edge) ? 'Keep' : 'Remove'} the link to ${addr(l.target.node, null, l.target.element)}`}
              onClick={() => p.onUnlink(l.edge)}>{p.unlinked.includes(l.edge) ? 'keep' : 'unlink'}</button>}
          </span>
        ))}</div>}
        {e.relied_on_by.length > 0 && <div className="links">relied on by {e.relied_on_by.map((l) => chip(l, 'source'))}</div>}
      </div>
      {!p.editing && (
        <div className="acts">
          {status}{open.length > 0 && <Pill tone="question">asks</Pill>}
          {p.writable && !p.removed && <button type="button" className="btn quiet" onClick={p.onEdit}>Edit</button>}
          {p.seq !== null && <button type="button" className="btn quiet" onClick={p.onAsk}>Ask</button>}
        </div>
      )}
      {(e.marks.length > 0 || e.queries.length > 0 || p.asking) && (
        <div className="flags">
          {e.marks.map((m) => <MarkBox key={m.id} mark={m} me={p.me} act={p.act} onRevise={p.writable ? p.onEdit : undefined} />)}
          {e.queries.map((q) => <QueryBox key={q.id} query={q} me={p.me} act={p.act} />)}
          {p.asking && <AskForm name={p.name} seq={p.seq ?? undefined} element={e.id} layer={undefined} act={p.act} onDone={p.onCancel} />}
        </div>
      )}
    </li>
  );
}

function AskForm({ name, seq, element, act, onDone }: { name: string; seq?: number; element?: string; layer?: string; act: Act; onDone(): void }) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<QueryKind>('question');
  const id = `ask-${element ?? name}`;
  return (
    <form className="qbox ask-form" onSubmit={async (ev) => {
      ev.preventDefault();
      if (await act.run(() => api('queries', { node: name, seq, element, kind, text }), kind === 'note' ? 'Noted. It waits for the layer that owns it.' : 'Asked. It went to the layer that owns the answer.')) onDone();
    }}>
      <label htmlFor={id}>{kind === 'note' ? 'Leave a note on' : 'Ask about'} <Addr>{addr(name, seq, element)}</Addr>. It goes to the layer that owns it.</label>
      <div className="seg" role="radiogroup" aria-label="Kind" style={{ justifySelf: 'start' }}>
        {(['question', 'note'] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}>{k === 'question' ? 'Question' : 'Note'}</button>)}
      </div>
      <textarea id={id} required autoFocus value={text} onChange={(ev) => setText(ev.target.value)}
        placeholder={kind === 'note' ? 'What are you going ahead with, and why?' : 'What isn’t clear, and what are the options?'} />
      <div className="edit-row"><button type="submit" className="btn primary" disabled={!text.trim()}>{kind === 'note' ? 'Leave note' : 'Ask'}</button>
        <button type="button" className="btn quiet" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

function ReviewBar({ name, review, mine, reading, read, onVerdict, onAbandon }: {
  name: string; review: WebNodeView['in_review'][number]; mine: boolean; reading?: number;
  read(v?: number): void; onVerdict(seq: number, v: 'approve' | 'request_changes', note?: string): void; onAbandon(): void;
}) {
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  const who = review.reviewers.length ? review.reviewers.join(', ') : 'its reviewers';
  return (
    <div className="draftbar" role="region" aria-label="In review">
      <span className="what"><span className="drafted">In review</span> · Version {review.seq} of {addr(name)}, submitted by {review.author} {ago(review.at)}, waits for {who}. Nothing changes for anyone until one approves.</span>
      {reading !== review.seq && <button type="button" className="btn quiet" onClick={() => read(review.seq)}>Read v{review.seq}</button>}
      {mine && <button type="button" className="btn quiet" onClick={onAbandon}>Abandon</button>}
      {review.for_me && (asking ? (
        <>
          <label className="sr-only" htmlFor="changes-note">What must change</label>
          <textarea id="changes-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="What must change, and why?" />
          <button type="button" className="btn quiet" onClick={() => setAsking(false)}>Cancel</button>
          <button type="button" className="btn primary" disabled={!note.trim()} onClick={() => onVerdict(review.seq, 'request_changes', note)}>Request changes</button>
        </>
      ) : (
        <>
          <button type="button" className="btn quiet" onClick={() => setAsking(true)}>Request changes</button>
          <button type="button" className="btn primary" onClick={() => onVerdict(review.seq, 'approve')}>Approve</button>
        </>
      ))}
    </div>
  );
}

function Notice({ outcome: o, onDismiss }: { outcome: WebOutcome & { node: string }; onDismiss(): void }) {
  const at = <Addr>{addr(o.node, o.seq)}</Addr>;
  const [tone, word, head] = o.committed ? ['clean', 'committed', <>Committed {at}</>] as const
    : o.in_review ? ['question', 'in review', <>Submitted {at} for review</>] as const
    : o.stale ? ['boundary', 'stale', <>{at} was overtaken</>] as const
    : o.abandoned ? ['boundary', 'rejected', <>Didn’t pass the structural checks</>] as const
    : ['boundary', 'changes requested', <>Not approved</>] as const;
  return (
    <section className="notice" role="status">
      <h2><Pill tone={tone}>{word}</Pill> {head}</h2>
      <p>
        {o.committed ? (o.unreviewed ? 'No one else holds Write on this layer, so Kolab’s structural checks alone committed it.' : 'Approved.') + (o.cascade_queued ? ' Its cascade waits behind an earlier one of this node.' : ' Whatever relied on what changed is marked stale.')
          : o.in_review ? `Structural checks passed. ${o.reviewers.length ? `${o.reviewers.join(', ')} ${o.reviewers.length > 1 ? 'have each' : 'has'} been asked to review it.` : ''} Until one approves, nothing downstream changes.`
          : o.stale ? 'Someone else committed to it after this was drafted. Nothing was wrong with your edits: they are still here, on the new version.'
          : o.note ?? ''}
        {o.abandoned && o.note ? ` ${o.note} Your edits are still here: fix them and submit again.` : ''}
      </p>
      <button type="button" className="btn quiet close" onClick={onDismiss}>Dismiss</button>
    </section>
  );
}

function copy(text: string, act: Act) {
  const done = () => act.run(async () => undefined, `Copied ${text}`);
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, done); else void done();
}
