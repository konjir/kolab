import { useEffect, useRef, useState } from 'react';
import { nobodyCanReview, type Layer, type QueryKind, type WebElement, type WebLink, type WebMe, type WebNodeView, type WebOutcome, type WebQueriesView, type WebVersion, type WebVersionsView, type WebWorkState, type WorkFields } from '@konjir/types';
import { api, pushed } from '../api.js';
import { addr, ago, nextElementId } from '../util.js';
import { Addr, Diff, Pill } from './bits.js';
import { MarkBox, QueryBox, markWord, type Act } from './Marks.js';
import { CaseBox, DirectRuleForm, OpenCaseForm, RulingBox } from './Cases.js';
import { More, useMore } from './Pages.js';

const KIND_WORD: Record<string, string> = {
  spec: 'Functional spec', prototype: 'Prototype', binding: 'Technical binding', plan: 'Plan (retired)',
};
/** What a node is to its parent (D78): a binding binds its spec; a plan, retired (D104), saw its work move to its binding. */
const PARENT_WORD: Record<string, string> = { binding: 'binds', plan: 'its work moved to' };

/**
 * Edits not yet submitted: kept in the page, per node, until submitted or discarded. `replaces` is
 * the session's own draft that came back with changes requested, being edited: its changes are the
 * edits, made on the version it was built on, and submitting them replaces it with a new version.
 */
interface Draft { changes: Record<string, string>; added: { id: string; text: string; parent?: string; work?: WorkFields }[]; removed: string[]; unlinked: string[]; replaces?: number }
const EMPTY: Draft = { changes: {}, added: [], removed: [], unlinked: [] };

export interface NodeViewProps {
  me: WebMe; name: string; version?: number; tick: number; act: Act;
  go(route: string): void;
  /** Opens a version of this node (undefined for the latest). */
  read(version?: number): void;
  focus?: string;
  /** Another kolab's node, read in place (D49): read only, its committed work alone. */
  kolab?: string;
}

/**
 * One node, as the prototype's Spec and Binding pages show it: its elements, each with its links,
 * marks, questions and notes beside it; its versions; edits kept as a draft until submitted for
 * review; and the review of a version in review, for whoever is asked to give it.
 */
export function NodeView({ me, name, version, tick, act, go, read, focus, kolab }: NodeViewProps) {
  const [view, setView] = useState<WebNodeView>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [editing, setEditing] = useState<string>();
  const [asking, setAsking] = useState<string | null>();
  const [notice, setNotice] = useState<Outcome>();
  /** The element a case file is being opened on, or a ruling given on (null: the whole node). */
  const [casing, setCasing] = useState<string>();
  const [ruling, setRuling] = useState<string | null>();

  const revising = draft.replaces !== undefined;
  const path = kolab ? `kolabs/${encodeURIComponent(kolab)}/nodes/${encodeURIComponent(name)}` : `nodes/${encodeURIComponent(name)}`;
  // Older versions, and older questions on the node as a whole, a page at a time (W2.21).
  const older = useMore<WebVersionsView>(`${path}/versions`, view?.versions_next, tick);
  const olderQueries = useMore<WebQueriesView>(`${path}/queries`, view?.queries_next, tick);
  const lastRead = useRef<{ key: string; tick: number }>(undefined);
  useEffect(() => {
    let live = true;
    // A re-read a push prompted renews no lease on its person's work (D100).
    const push = pushed(lastRead, JSON.stringify([path, version, me.actor, revising]), tick);
    api<WebNodeView>(`${path}${version ? `?version=${version}` : ''}`, undefined, undefined, { push })
      // Nothing committed yet: read the version waiting instead, so its requirements aren't missing.
      // Not while a returned draft is being edited: its edits are made on nothing, and shown as added.
      .then((v) => {
        const waiting = !version && !kolab && !revising && v.reading === null ? pendingSeq(v, me.actor) : undefined;
        return waiting === undefined ? v : api<WebNodeView>(`${path}?version=${waiting}`, undefined, undefined, { push });
      })
      .then((v) => { if (live) { setView(v); setError(undefined); } }, (e: Error) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [path, version, tick, me.actor, revising]);
  // A submission's notice follows its version as the page re-reads it (each change Kolab signals):
  // in review until it commits, comes back with changes requested, or is abandoned. A version
  // folded onto the node's newer version lives on as the fold, so the notice follows the fold.
  useEffect(() => {
    if (!view || view.node.name !== notice?.node || !notice.in_review) return;
    const folds = new Map((view.folded ?? []).map((f) => [f.seq, f.into]));
    let seq = notice.seq;
    for (let i = 0; i < 50 && folds.has(seq); i++) seq = folds.get(seq)!;
    const followed = seq !== notice.seq;
    const n: Outcome = followed ? { ...notice, seq, from: notice.from ?? notice.seq, seen: true } : notice;
    const now = view.versions.find((v) => v.seq === seq);
    // Missing from a read made before the submission landed says nothing: gone only once seen in review.
    if (now?.state === 'in_review') { if (followed || !notice.seen) setNotice({ ...n, seen: true }); }
    else if (now || n.seen) setNotice(settled(n, now));
  }, [view, notice]);
  useEffect(() => { setDraft(EMPTY); setEditing(undefined); setAsking(undefined); setNotice(undefined); setCasing(undefined); setRuling(undefined); }, [name, kolab]);
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
  const foreign = view.foreign;
  /** A version not committed (in review, or a draft): read as asked, or because nothing is committed yet. */
  const uncommitted = !!reading && reading.state !== 'committed';
  const writable = !foreign && view.can_write && (isLatest || (latest === null && !uncommitted)) && !mineInReview;
  // Case files and rulings are for those who belong to the kolab's work (D49); a ruling, for a
  // person with Write on the layer, from its role (D51): Kolab decides, the page only offers.
  const committed = reading?.state === 'committed';
  const belongs = !foreign && me.access.layers.length > 0;
  const canRule = !foreign && view.can_write && me.kind === 'person' && committed;
  const whyNot = !view.can_write
    ? (view.node.layer === 'functional' ? 'Engineers can’t change intent. Ask the spec instead.' : 'Product can’t change implementation. Ask the binding instead.')
    : mineInReview ? `Version ${mineInReview.seq} is in review. Edits wait until it is decided.`
    : uncommitted && latest === null ? `Version ${reading?.seq} is ${reading?.state === 'in_review' ? 'in review' : 'a draft'}. Edits wait until it is decided.` : '';
  const changes = Object.keys(draft.changes).length + draft.added.length + draft.removed.length + draft.unlinked.length;
  const compared = view.compared_with && (!isLatest || reading?.state !== 'committed')
    ? new Map(view.compared_with.elements.map((e) => [e.id, e.text])) : undefined;

  const save = (id: string, text: string) => {
    setDraft((d) => {
      const added = d.added.find((a) => a.id === id);
      if (added) return { ...d, added: d.added.map((a) => (a.id === id ? { ...a, text } : a)) };
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
        ...draft.added.map((a) => ({ kind: 'add' as const, element: a.id, text: a.text, ...(a.parent ? { parent: a.parent } : {}), ...(a.work ? { work: a.work } : {}) })),
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
  /**
   * Edits a draft of the session's own that came back: its changes, against the version it was
   * built on, become the page's edits, to change further and resubmit. Only one built on the live
   * version: on an older one, its edits would undo what committed since.
   */
  const revise = (d: WebVersion) => act.run(async () => {
    const v = await api<WebNodeView>(`nodes/${encodeURIComponent(name)}?version=${d.seq}`);
    const on = v.compared_with?.seq ?? null;
    if (on !== latest) throw new Error(`${addr(name, d.seq)} was drafted on ${on === null ? 'nothing committed' : `v${on}`}, and v${latest} is committed now. Resubmit it as it is, and Kolab brings it up to date, or abandon it.`);
    const before = new Map((v.compared_with?.elements ?? []).map((e) => [e.id, e.text]));
    const kept = new Set(v.elements.map((e) => e.id));
    setDraft({
      changes: Object.fromEntries(v.elements.filter((e) => before.has(e.id) && before.get(e.id) !== e.text).map((e) => [e.id, e.text])),
      added: v.elements.filter((e) => !before.has(e.id)).map((e) => ({ id: e.id, text: e.text, ...(e.parent ? { parent: e.parent } : {}), ...(e.work ? { work: e.work } : {}) })),
      removed: [...before.keys()].filter((id) => !kept.has(id)),
      unlinked: [], replaces: d.seq,
    });
    setEditing(undefined);
    if (version !== undefined) read(undefined);
  }, `Editing ${addr(name, d.seq)}. Resubmitting puts your edits in a new version in its place.`);
  const versionVerb = (seq: number, verb: 'resubmit' | 'abandon', done: string) =>
    act.run(async () => {
      const out = await api<WebOutcome | { state: string }>(`nodes/${encodeURIComponent(name)}/versions/${seq}/${verb}`, {});
      if ('seq' in out) setNotice({ ...out, node: name });
    }, done);

  const versions = [...view.versions, ...older.pages.flatMap((p) => p.versions)].sort((a, b) => a.seq - b.seq);
  const nodeQueries = [...view.queries, ...olderQueries.pages.flatMap((p) => p.queries)];
  const rows = reading ? [...view.elements, ...(isLatest || latest === null ? draft.added.map(asElement(name)) : [])] : draft.added.map(asElement(name));
  return (
    <>
      {notice && <Notice outcome={notice} layer={view.node.layer} onDismiss={() => setNotice(undefined)} />}
      <section aria-labelledby="doc-title">
        <div className="doc-head">
          <span className="kind">{KIND_WORD[view.node.kind] ?? view.node.kind}</span>
          {view.node.parent && <span className="kind">{PARENT_WORD[view.node.kind] ?? 'of'} <Addr>{foreign ? `kj:${view.kolab}/${view.node.parent}` : addr(view.node.parent)}</Addr></span>}
          <h2 id="doc-title">{view.node.title}</h2>
          <Addr>{foreign ? `kj:${view.kolab}/${name}${reading ? `@${reading.seq}` : ''}` : addr(name, reading?.seq)}</Addr>
          <div className="doc-meta">
            {reading
              ? <>Version {reading.seq}{reading.state === 'committed' ? `, committed by ${reading.author}` : reading.state === 'in_review' ? `, in review, by ${reading.author}` : `, your draft`} {ago(reading.at)}{reading.note ? ` · ${reading.note}` : ''}</>
              : 'Nothing committed yet.'}
            {reading && !isLatest && reading.state === 'committed' && <span className="reading-old"> · An older version. Read only.</span>}
            {uncommitted && <span className="reading-old"> · Not committed yet{latest === null ? ': nothing is, so this is the version waiting' : ''}. Nothing changes for anyone until it’s approved.</span>}
            {versions.length > 0 && (
              <div className="versions" role="group" aria-label="Versions">
                {older.more && <button type="button" disabled={older.busy} onClick={older.more}>{older.busy ? 'Reading…' : 'Older …'}</button>}
                {versions.map((v) => (
                  <button key={v.seq} type="button" aria-pressed={v.seq === reading?.seq} onClick={() => read(v.seq === latest ? undefined : v.seq)}
                    title={v.state === 'committed' ? `Committed by ${v.author}` : v.state === 'in_review' ? `In review, by ${v.author}` : 'Your draft'}>
                    v{v.seq}{v.state === 'in_review' ? ' · in review' : v.state === 'drafted' ? ' · draft' : ''}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {foreign && (
          <div className="foreign" role="note" style={{ marginTop: 12 }}>
            <span>Read in place from kolab <b>{view.kolab}</b>: its committed versions, with their questions, and nothing it keeps to its own work. Nothing can be changed or asked from here.</span>
            <button type="button" className="btn quiet" onClick={() => go(`read/${view.kolab}`)}>All of {view.kolab}</button>
          </div>
        )}
        {(nodeQueries.length > 0 || view.rulings.length > 0) && <div className="flags" style={{ marginTop: 12 }}>
          {view.rulings.map((r) => <RulingBox key={r.ruling} ruling={r} me={me} go={go} />)}
          {nodeQueries.map((q) => <QueryBox key={q.id} query={q} me={me} act={act} readOnly={foreign} />)}
          <More more={olderQueries.more} busy={olderQueries.busy} what={`questions on ${addr(name)}`} /></div>}
      </section>

      <ol className="els" aria-label="Elements">
        {rows.length ? rows.map((e) => (
          <ElementRow key={e.id} name={name} path={path} tick={tick} element={e} me={me} act={act} go={go}
            seq={reading?.seq ?? null} live={isLatest} writable={writable} focus={focus === `${name}#${e.id}`}
            text={draft.changes[e.id] ?? draft.added.find((a) => a.id === e.id)?.text ?? e.text}
            removed={draft.removed.includes(e.id)} drafted={e.id in draft.changes || draft.added.some((a) => a.id === e.id)}
            before={compared ? compared.get(e.id) ?? '' : undefined}
            editing={editing === e.id} asking={asking === e.id}
            onEdit={() => { setEditing(e.id); setAsking(undefined); }} onCancel={() => { setEditing(undefined); setAsking(undefined); }}
            onSave={(t) => save(e.id, t)} onRemove={() => remove(e.id)} unlinked={draft.unlinked}
            foreign={foreign} belongs={belongs && committed} canRule={canRule}
            casing={casing === e.id} onCase={() => { setCasing(casing === e.id ? undefined : e.id); setRuling(undefined); setAsking(undefined); }}
            ruling={ruling === e.id} onRule={() => { setRuling(ruling === e.id ? undefined : e.id); setCasing(undefined); setAsking(undefined); }}
            onFormDone={() => { setCasing(undefined); setRuling(undefined); }}
            onUnlink={(edge) => setDraft((d) => ({ ...d, unlinked: d.unlinked.includes(edge) ? d.unlinked.filter((x) => x !== edge) : [...d.unlinked, edge] }))} onAsk={() => { setAsking(e.id); setEditing(undefined); }} />
        )) : (
          <li className="empty">{view.node.layer === 'functional' ? 'No requirements yet.' : 'No elements yet.'} {writable ? 'Add the first one below.' : ''}</li>
        )}
      </ol>
      {writable && <div className="edit-row"><button type="button" className="btn" onClick={add}>Add {view.node.layer === 'functional' ? 'a requirement' : 'an element'}</button>
        <button type="button" className="btn quiet" onClick={() => setAsking(asking === null ? undefined : null)}>Ask about {addr(name)}</button>
        {canRule && <button type="button" className="btn quiet" onClick={() => setRuling(ruling === null ? undefined : null)}>Rule on {addr(name)}</button>}</div>}
      {!writable && whyNot && (isLatest || (uncommitted && latest === null)) && !foreign && <p className="why-not">{whyNot}</p>}
      {ruling === null && reading && <DirectRuleForm name={name} seq={reading.seq} act={act} onDone={() => setRuling(undefined)} />}
      {asking === null && <AskForm name={name} seq={reading?.seq} element={undefined} layer={view.node.layer} act={act} onDone={() => setAsking(undefined)} />}

      {view.drafts.map((d) => {
        const editable = !foreign && view.can_write && !mineInReview && (d.base === undefined || d.base === latest);
        return draft.replaces === d.seq ? (
          <div key={d.seq} className="notice" role="region" aria-label={`Your draft ${d.seq}`}>
            <h2><span className="drafted">Editing your draft</span> <Addr>{addr(name, d.seq)}</Addr></h2>
            <p>{d.note ? `It came back: ${d.note}` : 'Not submitted yet.'} Its changes are marked draft above: edit, add or remove, then resubmit. Your edits go in a new version, and {addr(name, d.seq)} is abandoned in its place.</p>
          </div>
        ) : (
          <div key={d.seq} className="notice" role="region" aria-label={`Your draft ${d.seq}`}>
            <h2><span className="drafted">Your draft</span> <Addr>{addr(name, d.seq)}</Addr></h2>
            <p>{d.note ? `It came back: ${d.note}` : 'Not submitted yet.'} {editable ? 'Edit it and resubmit, resubmit it as it is, or abandon it.' : 'Resubmit it as it is, or abandon it.'}{!editable && d.base !== undefined && d.base !== latest ? ` It was drafted on ${d.base === null ? 'nothing committed' : `v${d.base}`}; v${latest} is committed now, so resubmitting brings it up to date.` : ''}</p>
            <div className="edit-row">
              <button type="button" className="btn quiet" onClick={() => read(d.seq)}>Read it</button>
              <button type="button" className="btn" onClick={() => versionVerb(d.seq, 'abandon', `Abandoned ${addr(name, d.seq)}`)}>Abandon</button>
              {editable && <button type="button" className="btn" disabled={changes > 0} title={changes > 0 ? 'Submit or discard the edits you have first' : undefined} onClick={() => revise(d)}>Edit it</button>}
              <button type="button" className="btn primary" onClick={() => versionVerb(d.seq, 'resubmit', `Resubmitted ${addr(name, d.seq)}`)}>Resubmit{editable ? ' as it is' : ''}</button>
            </div>
          </div>
        );
      })}

      {inReview && <ReviewBar name={name} layer={view.node.layer} review={inReview} mine={inReview.author === me.actor} reading={reading?.seq} committed={latest}
        read={read} onVerdict={verdict} onAbandon={() => versionVerb(inReview.seq, 'abandon', `Abandoned ${addr(name, inReview.seq)}`)} />}
      {!inReview && changes > 0 && (
        <div className="draftbar" role="region" aria-label="Draft">
          <span className="what"><span className="drafted">Draft</span> · {changes} change{changes > 1 ? 's' : ''} to {addr(name)}{revising ? `, in place of your ${addr(name, draft.replaces)}` : ''}. Kolab checks its structure, then another writer of the {view.node.layer} layer reviews it. Nothing changes for anyone until it’s approved.</span>
          <button type="button" className="btn quiet" onClick={() => { setDraft(EMPTY); setEditing(undefined); }}>{revising ? 'Stop editing' : 'Discard'}</button>
          <button type="button" className="btn primary" onClick={submit}>{revising ? 'Resubmit for review' : 'Submit for review'}</button>
        </div>
      )}
    </>
  );
}

/**
 * The version to show when nothing is committed yet: the session's own in review, then its own
 * draft, then the newest in review. Undefined when there is none.
 */
function pendingSeq(v: WebNodeView, actor: string): number | undefined {
  const newest = (seqs: number[]) => (seqs.length ? Math.max(...seqs) : undefined);
  return newest(v.in_review.filter((r) => r.author === actor).map((r) => r.seq))
    ?? newest(v.drafts.map((d) => d.seq))
    ?? newest(v.in_review.map((r) => r.seq));
}

const asElement = (name: string) => (a: { id: string; text: string; work?: WorkFields }): WebElement =>
  ({ id: a.id, parent: null, text: a.text, ...(a.work ? { work: a.work } : {}), address: addr(name, null, a.id), queries: [], relies_on: [], relied_on_by: [], marks: [], rulings: [], cases: [] });

/**
 * A work package's fields (PLN1, D98), read only: the page shows them and keeps them as they are
 * when the text is edited. They are written through konjir_draft.
 */
function Work({ work, state, name }: { work: WorkFields; state?: WebWorkState; name: string }) {
  const facts: string[] = [];
  if (work.milestone) facts.push(work.target_date ? `Milestone, due ${work.target_date}` : 'Milestone');
  if (work.size) facts.push(`Size ${work.size}`);
  if (work.repo) facts.push(`In ${work.repo}`);
  return (
    <dl className="work" aria-label="Work package">
      {state && <WorkStateLine state={state} name={name} />}
      {facts.length > 0 && <div><dt className="sr-only">Kind</dt><dd>{facts.join(' · ')}</dd></div>}
      {work.done_when && <div><dt>Done when</dt><dd>{work.done_when}</dd></div>}
      {work.depends_on?.length ? <div><dt>{work.milestone ? 'Members' : 'Depends on'}</dt><dd>{work.depends_on.map((d) => <code key={d} title={addr(name, null, d)}>{d}</code>)}</dd></div> : null}
    </dl>
  );
}

const STATE_LABEL: Record<WebWorkState['state'], string> = { todo: 'To do', in_progress: 'In progress', in_review: 'In review', done: 'Done' };

/**
 * Where a work package stands (PLN12, W5.1b), read only: its state, who holds it and until when its
 * lease runs, and why it is blocked (PLN19). Agents pull and release work through MCP.
 */
function WorkStateLine({ state, name }: { state: WebWorkState; name: string }) {
  const held = state.state === 'in_progress' && state.assignee
    ? ` · ${state.assignee}${state.lease_until ? `, lease until ${new Date(state.lease_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`
    : state.assignee && state.state !== 'todo' ? ` · ${state.assignee}` : '';
  const why = state.blocked.map((b) => (b.reason === 'depends_on' ? `${b.work.replace(`kj:${name}#`, '')} (${STATE_LABEL[b.state]})`
    : b.reason === 'question' ? `an open question on ${b.on}` : `an open case file on ${b.on}`));
  return (
    <div className="work-state">
      <dt>State</dt>
      <dd><Pill tone={state.state === 'done' ? 'clean' : why.length && !state.milestone ? 'question' : 'stale'}>{STATE_LABEL[state.state]}</Pill>{state.at_risk && <> <Pill tone="stale">At risk</Pill></>}{held}
        {why.length > 0 && !state.milestone && <span className="blocked"> · Blocked by {why.join(', ')}</span>}</dd>
    </div>
  );
}

interface RowProps {
  /** The node's API path, and the push count: an element's older questions are read from it a page at a time. */
  path: string; tick: number;
  name: string; element: WebElement; me: WebMe; act: Act; go(route: string): void;
  seq: number | null; live: boolean; writable: boolean; focus: boolean;
  text: string; removed: boolean; drafted: boolean; before?: string; editing: boolean; asking: boolean;
  onEdit(): void; onCancel(): void; onSave(text: string): void; onRemove(): void; onAsk(): void;
  /** Links dropped in the draft (konjir_draft's unlink), and toggling one. */
  unlinked: string[]; onUnlink(edge: string): void;
  /** Read in place from another kolab: nothing to do but read. */
  foreign: boolean;
  /** The person may open a case file here (D49), or rule directly (D51); and whether either form is open. */
  belongs: boolean; canRule: boolean; casing: boolean; ruling: boolean;
  onCase(): void; onRule(): void; onFormDone(): void;
}

function ElementRow(p: RowProps) {
  const e = p.element;
  const [value, setValue] = useState(p.text);
  useEffect(() => { if (p.editing) setValue(p.text); }, [p.editing, p.text]);
  const olderQueries = useMore<WebQueriesView>(`${p.path}/queries?element=${encodeURIComponent(e.id)}`, e.queries_next, p.tick);
  const queries = [...e.queries, ...olderQueries.pages.flatMap((pg) => pg.queries)];
  const open = queries.filter((q) => q.state === 'open');
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
        {(e.work || e.work_state) && <Work work={e.work ?? {}} state={e.work_state} name={p.name} />}
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
          {status}{open.length > 0 && <Pill tone="question">asks</Pill>}{e.cases.length > 0 && <Pill tone="boundary">disputed</Pill>}
          {p.writable && !p.removed && <button type="button" className="btn quiet" onClick={p.onEdit}>Edit</button>}
          {p.seq !== null && !p.foreign && <button type="button" className="btn quiet" onClick={p.onAsk}>Ask</button>}
          {p.seq !== null && p.belongs && !p.drafted && <button type="button" className="btn quiet" onClick={p.onCase} title="Open a case file: a disagreement about this element that you couldn’t settle">Dispute</button>}
          {p.seq !== null && p.canRule && !p.drafted && <button type="button" className="btn quiet" onClick={p.onRule} title="Rule on this element directly, with no case file behind it">Rule</button>}
        </div>
      )}
      {(e.marks.length > 0 || queries.length > 0 || e.cases.length > 0 || e.rulings.length > 0 || p.asking || p.casing || p.ruling) && (
        <div className="flags">
          {e.marks.map((m) => <MarkBox key={m.id} mark={m} me={p.me} act={p.act} onRevise={p.writable ? p.onEdit : undefined} />)}
          {e.cases.map((c) => <CaseBox key={c.case} c={c} me={p.me} act={p.act} go={p.go} />)}
          {e.rulings.map((r) => <RulingBox key={r.ruling} ruling={r} me={p.me} go={p.go} showOn={r.seq !== p.seq} />)}
          {queries.map((q) => <QueryBox key={q.id} query={q} me={p.me} act={p.act} readOnly={p.foreign} />)}
          <More more={olderQueries.more} busy={olderQueries.busy} what={`questions on ${e.id}`} />
          {p.asking && <AskForm name={p.name} seq={p.seq ?? undefined} element={e.id} layer={undefined} act={p.act} onDone={p.onCancel} />}
          {p.casing && p.seq !== null && <OpenCaseForm name={p.name} seq={p.seq} element={e.id} act={p.act} onDone={p.onFormDone} />}
          {p.ruling && p.seq !== null && <DirectRuleForm name={p.name} seq={p.seq} element={e.id} act={p.act} onDone={p.onFormDone} />}
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

function ReviewBar({ name, layer, review, mine, reading, committed, read, onVerdict, onAbandon }: {
  name: string; layer: Layer; review: WebNodeView['in_review'][number]; mine: boolean; reading?: number;
  /** The latest committed version, which the page shows unless asked for another. */
  committed: number | null;
  read(v?: number): void; onVerdict(seq: number, v: 'approve' | 'request_changes', note?: string): void; onAbandon(): void;
}) {
  const [note, setNote] = useState('');
  const [asking, setAsking] = useState(false);
  // Who can review it now (D65); when nobody else can yet, how to get a reviewer.
  const who = review.reviewers.join(', ');
  const nobody = nobodyCanReview(layer);
  return (
    <div className="draftbar" role="region" aria-label="In review">
      <span className="what"><span className="drafted">In review</span> · {committed !== null && reading === committed && reading !== review.seq ? (
        <>The changes are in <a href={`#/node/${name}@${review.seq}`} onClick={(e) => { e.preventDefault(); read(review.seq); }}>v{review.seq}</a>, submitted by {review.author} {ago(review.at)}. This page shows v{committed}, the committed version. v{review.seq} {who ? <>waits for {who}; nothing changes for anyone until one approves.</> : <>waits. {nobody}</>}</>
      ) : (
        <>Version {review.seq} of {addr(name)}, submitted by {review.author} {ago(review.at)}, {who ? <>waits for {who}. Nothing changes for anyone until one approves.</> : <>waits. {nobody}</>}</>
      )}</span>
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

/**
 * A submission's outcome, on its node; `gone` once it left review without committing or coming
 * back; `from`, the version submitted, when it was folded onto a newer version as `seq`.
 */
type Outcome = WebOutcome & { node: string; gone?: boolean; seen?: boolean; from?: number };

/** What became of a version the notice said was in review, from the version as the page now reads it. */
function settled(o: Outcome, now: WebVersion | undefined): Outcome {
  const left = { ...o, in_review: false, stale: false, abandoned: false, cascade_queued: false, reviewers: [] };
  if (now?.state === 'committed') return { ...left, ok: true, committed: true, unreviewed: false, note: null };
  if (now?.state === 'drafted') return { ...left, ok: false, committed: false, note: now.note };
  return { ...left, ok: false, committed: false, note: null, gone: true };
}

function Notice({ outcome: o, layer, onDismiss }: { outcome: Outcome; layer: Layer; onDismiss(): void }) {
  const at = <Addr>{addr(o.node, o.seq)}</Addr>;
  const [tone, word, head] = o.committed ? ['clean', 'committed', <>Committed {at}</>] as const
    : o.in_review ? ['question', 'in review', <>Submitted {at} for review</>] as const
    : o.gone ? ['boundary', 'closed', <>{at} is no longer in review</>] as const
    : o.stale ? ['boundary', 'stale', <>{at} was overtaken</>] as const
    : o.abandoned ? ['boundary', 'rejected', <>Didn’t pass the structural checks</>] as const
    : ['boundary', 'changes requested', <>Not approved</>] as const;
  return (
    <section className="notice" role="status">
      <h2><Pill tone={tone}>{word}</Pill> {head}</h2>
      <p>
        {o.from !== undefined && !o.gone ? `Your ${addr(o.node, o.from)} was folded onto the node’s newer version, as v${o.seq}. ` : ''}
        {o.committed ? (o.unreviewed ? 'No one else holds Write on this layer, so Kolab’s structural checks alone committed it.' : 'Approved.') + (o.cascade_queued ? ' Its cascade waits behind an earlier one of this node.' : ' Whatever relied on what changed is marked stale.')
          : o.in_review ? (o.reviewers.length
            ? `Structural checks passed. ${o.reviewers.join(', ')} ${o.reviewers.length > 1 ? 'have each' : 'has'} been asked to review it. Until one approves, nothing downstream changes.`
            : `Structural checks passed. ${nobodyCanReview(layer)} Until then, nothing downstream changes.`)
          : o.stale ? 'Someone else committed to it after this was drafted. Nothing was wrong with your edits: they are still here, on the new version.'
          : o.gone ? 'It was abandoned or rejected. Nothing changed for anyone.'
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
