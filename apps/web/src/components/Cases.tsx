import { useState, type FormEvent } from 'react';
import type { PositionVerdict, RulingEffect, WebCase, WebCasesView, WebMe, WebRuling, WebRulingsView } from '@konjir/types';
import { api } from '../api.js';
import { addr, ago, parseKj, routeOf, sideWord } from '../util.js';
import { Pill } from './bits.js';
import type { Act } from './Marks.js';
import { useRead } from './Pages.js';

/**
 * Case files and rulings (W3.2; CASE1–CASE7, D49, D51), each a call to one of the agents' verbs
 * through Kolab's web API. The page offers only what the person may do (WebCase.you); Kolab decides.
 */

const ROLE_OF_LAYER: Record<string, string> = { functional: 'product', technical: 'engineer' };
const lines = (t: string) => t.split('\n').map((x) => x.trim()).filter(Boolean);

/** An address in the page: a chip that opens it, in place if it is another kolab's. */
function AddrChip({ address, here, go }: { address: string; here: string; go(r: string): void }) {
  const a = parseKj(address);
  if (!a) return <code>{address}</code>;
  return <button type="button" className="chip" onClick={() => go(routeOf(a, here))}>{address}</button>;
}

/** A ruling beside what it rules on: precedent in its kolab (CASE4), never changed once given. */
export function RulingBox({ ruling: r, me, go, showOn }: { ruling: WebRuling; me: WebMe; go(r: string): void; showOn?: boolean }) {
  return (
    <div className="rulingbox" data-ruling={r.ruling}>
      <div className="head">
        <Pill tone="clean">ruling</Pill>
        <span>{r.effect === 'change_intent' ? 'Changes the intent' : r.effect === 'keep_intent' ? 'Keeps the intent: find another way to meet it as written' : 'Precedent'}
          {showOn !== false && <> · on <AddrChip address={r.on} here={me.kolab} go={go} /></>}</span>
      </div>
      <blockquote>{r.text}</blockquote>
      {r.replaces && <div className="why-not">Replaces: {r.replaces}</div>}
      <div className="by">{r.ruled_by} ruled{r.ruled_at ? ` ${ago(r.ruled_at)}` : ''}{r.case ? ', on a case file' : ', directly'}. It is precedent here: agents are served it, so it isn’t argued again.</div>
    </div>
  );
}

/** A case file: the question in dispute, its two positions with their evidence, and its ruling once given. */
export function CaseBox({ c, me, act, go }: { c: WebCase; me: WebMe; act: Act; go(r: string): void }) {
  const [arguing, setArguing] = useState(false);
  const open = c.state === 'open';
  const first = c.positions[0];
  return (
    <div className={`casebox${open ? '' : ' settled'}`} data-case={c.case} role="group" aria-label={`Case file on ${c.on}`}>
      <div className="head">
        {open ? <Pill tone="boundary">case file</Pill> : c.state === 'ruled' ? <Pill tone="clean">ruled</Pill> : <Pill tone="clean">superseded</Pill>}
        <span>on <AddrChip address={c.on} here={me.kolab} go={go} />{c.opened_by ? ` · opened by ${c.opened_by}` : ''}{c.opened_at ? ` ${ago(c.opened_at)}` : ''}</span>
      </div>
      {c.question && <blockquote>{c.question}</blockquote>}
      <div className="positions">
        {c.positions.map((p) => (
          <div key={p.position} className={`position${p.verdict ? ` ${p.verdict}` : ''}`} data-position={p.position}>
            <div className="side">
              <span>Seeks to {sideWord(p.seeks)}</span>
              {p.verdict && <Pill tone={p.verdict === 'sustained' ? 'clean' : 'boundary'}>{p.verdict}</Pill>}
            </div>
            <span className="why-not">{p.actor}{p.taken_at ? ` · ${ago(p.taken_at)}` : ''}</span>
            <p>{p.claim}</p>
            {p.evidence.length > 0 && (
              <ul className="evidence" aria-label="Evidence">
                {p.evidence.map((e, i) => <li key={i}>{e.startsWith('kj:') ? <AddrChip address={e} here={me.kolab} go={go} /> : <code>{e}</code>}</li>)}
              </ul>
            )}
          </div>
        ))}
        {open && c.positions.length === 1 && (
          <div className="position"><div className="side">The other side</div>
            <p className="why-not">Not taken yet. Work goes on meanwhile: an open case file blocks nothing (CASE7).</p></div>
        )}
      </div>
      {c.ruling && <RulingBox ruling={c.ruling} me={me} go={go} showOn={false} />}
      {open && (
        c.you.can_rule ? <RuleCaseForm c={c} act={act} />
          : c.you.can_argue ? (arguing
            ? <PositionForm c={c} act={act} onDone={() => setArguing(false)} />
            : <div className="edit-row"><button type="button" className="btn" onClick={() => setArguing(true)}>Take the other side</button>
              <span className="why-not">Your position will seek to {sideWord(first?.seeks === 'change_intent' ? 'keep_intent' : 'change_intent')}.</span></div>)
            : <p className="why-not">{c.you.party
              ? 'You hold a side of this case file, or your agent does: one person and their agents are one side, so someone else takes the other and someone else rules.'
              : c.positions.length < 2
                ? `Waiting for the other side, from someone with Write in this kolab who isn’t ${first?.actor ?? 'the opener'} or of the same person.`
                : `Waiting for a ruling from a person with Write on the ${c.layer} layer, working as ${ROLE_OF_LAYER[c.layer]}, who isn’t a party.`}</p>
      )}
    </div>
  );
}

function PositionForm({ c, act, onDone }: { c: WebCase; act: Act; onDone(): void }) {
  const [claim, setClaim] = useState('');
  const [evidence, setEvidence] = useState('');
  const id = `pos-${c.case}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api(`cases/${encodeURIComponent(c.case)}/positions`, { claim, evidence: lines(evidence) }), 'Your position is on the case file. A person rules on it now.')) onDone();
  };
  return (
    <form className="case-form" onSubmit={submit}>
      <label htmlFor={`${id}-claim`}>Your position: the other side</label>
      <textarea id={`${id}-claim`} required value={claim} onChange={(e) => setClaim(e.target.value)} placeholder="What you claim, and why the other position is wrong" />
      <label htmlFor={`${id}-ev`}>Evidence, one per line</label>
      <textarea id={`${id}-ev`} required value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder={'kj: addresses, a commit, a file and line, a test run'} />
      <div className="edit-row"><button type="submit" className="btn primary" disabled={!claim.trim() || !lines(evidence).length}>Take the other side</button>
        <button type="button" className="btn quiet" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** A ruling on a case file (D51): it sustains exactly one of the two positions, and overrules the other. */
function RuleCaseForm({ c, act }: { c: WebCase; act: Act }) {
  const [sustain, setSustain] = useState<string>();
  const [text, setText] = useState('');
  const [replaces, setReplaces] = useState('');
  const id = `rule-${c.case}`;
  const sustained = c.positions.find((p) => p.position === sustain);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!sustain) return;
    const verdicts: Record<string, PositionVerdict> = Object.fromEntries(c.positions.map((p) => [p.position, p.position === sustain ? 'sustained' : 'overruled']));
    await act.run(() => api(`cases/${encodeURIComponent(c.case)}/rule`, { text, verdicts, replaces: replaces.trim() || undefined }),
      sustained?.seeks === 'change_intent' ? `Ruled: the intent changes. ${c.on.replace(/@\d+/, '')} is marked until a version amends it.` : 'Ruled: the intent stands.');
  };
  return (
    <form className="case-form" onSubmit={submit} aria-label={`Rule on the case file on ${c.on}`}>
      <fieldset>
        <legend>Rule: sustain one position, which overrules the other</legend>
        {c.positions.map((p) => (
          <label key={p.position} className="choice">
            <input type="radio" name={id} value={p.position} checked={sustain === p.position} onChange={() => setSustain(p.position)} />
            <span>Sustain {p.actor}’s: {sideWord(p.seeks)}</span>
          </label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-text`}>The ruling, as agents will be served it</label>
      <textarea id={`${id}-text`} required value={text} onChange={(e) => setText(e.target.value)} />
      <label htmlFor={`${id}-rep`}>What it replaces <span className="why-not">optional</span></label>
      <input id={`${id}-rep`} type="text" value={replaces} onChange={(e) => setReplaces(e.target.value)} />
      <div className="edit-row"><button type="submit" className="btn primary" disabled={!sustain || !text.trim()}>Rule</button>
        <span className="why-not">{sustained ? (sustained.seeks === 'change_intent' ? 'It changes the intent: the element is marked, with a question to its layer, until a version amends it.' : 'It keeps the intent: whoever couldn’t meet it finds another way.') : 'A ruling never changes once given; a later one says what it replaces.'}</span></div>
    </form>
  );
}

/** Opens a case file on an element (CASE1, CASE5): the question in dispute and the opener's position. */
export function OpenCaseForm({ name, seq, element, act, onDone }: { name: string; seq: number; element: string; act: Act; onDone(): void }) {
  const [question, setQuestion] = useState('');
  const [claim, setClaim] = useState('');
  const [evidence, setEvidence] = useState(addr(name, seq, element));
  const [seeks, setSeeks] = useState<RulingEffect>('change_intent');
  const id = `case-${element}`;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (await act.run(() => api('cases', { node: name, seq, element, question, claim, evidence: lines(evidence), seeks }),
      'Case file opened. It waits for the other side, then a person rules. Nothing is blocked meanwhile.')) onDone();
  };
  return (
    <form className="qbox case-form" onSubmit={submit} aria-label={`Open a case file on ${addr(name, seq, element)}`}>
      <p className="why-not" style={{ margin: 0 }}>A case file is for a disagreement the two sides couldn’t settle. Most things need an answer, not a ruling: ask first.</p>
      <label htmlFor={`${id}-q`}>The question in dispute</label>
      <textarea id={`${id}-q`} required value={question} onChange={(e) => setQuestion(e.target.value)} />
      <fieldset>
        <legend>Your position seeks to</legend>
        {(['change_intent', 'keep_intent'] as const).map((s) => (
          <label key={s} className="choice"><input type="radio" name={`${id}-side`} checked={seeks === s} onChange={() => setSeeks(s)} />
            <span>{s === 'change_intent' ? 'Change the intent: it can’t be met as written' : 'Keep the intent as written'}</span></label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-claim`}>Your claim</label>
      <textarea id={`${id}-claim`} required value={claim} onChange={(e) => setClaim(e.target.value)} />
      <label htmlFor={`${id}-ev`}>Evidence, one per line</label>
      <textarea id={`${id}-ev`} required value={evidence} onChange={(e) => setEvidence(e.target.value)} />
      <div className="edit-row"><button type="submit" className="btn primary" disabled={!question.trim() || !claim.trim() || !lines(evidence).length}>Open case file</button>
        <button type="button" className="btn quiet" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** A ruling given directly, with no case file behind it (CASE3, D16), on an element or the whole node. */
export function DirectRuleForm({ name, seq, element, act, onDone }: { name: string; seq: number; element?: string; act: Act; onDone(): void }) {
  const [text, setText] = useState('');
  const [effect, setEffect] = useState<RulingEffect>();
  const [replaces, setReplaces] = useState('');
  const id = `drule-${element ?? name}`;
  const at = addr(name, seq, element);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!effect) return;
    if (await act.run(() => api('rulings', { node: name, seq, element, text, effect, replaces: replaces.trim() || undefined }),
      effect === 'change_intent' ? `Ruled: the intent changes. It is marked until a version amends it.` : 'Ruled: the intent stands.')) onDone();
  };
  return (
    <form className="qbox case-form" onSubmit={submit} aria-label={`Rule directly on ${at}`}>
      <p className="why-not" style={{ margin: 0 }}>A ruling given directly, with no case file behind it. It supersedes any case file still open on {element ? 'the element' : 'it'}, and is precedent from now on.</p>
      <fieldset>
        <legend>The ruling</legend>
        {(['change_intent', 'keep_intent'] as const).map((s) => (
          <label key={s} className="choice"><input type="radio" name={`${id}-effect`} checked={effect === s} onChange={() => setEffect(s)} />
            <span>{s === 'change_intent' ? 'Changes the intent: it is marked until a version amends it' : 'Keeps the intent: find another way to meet it as written'}</span></label>
        ))}
      </fieldset>
      <label htmlFor={`${id}-text`}>What it says, as agents will be served it</label>
      <textarea id={`${id}-text`} required value={text} onChange={(e) => setText(e.target.value)} />
      <label htmlFor={`${id}-rep`}>What it replaces <span className="why-not">optional</span></label>
      <input id={`${id}-rep`} type="text" value={replaces} onChange={(e) => setReplaces(e.target.value)} />
      <div className="edit-row"><button type="submit" className="btn primary" disabled={!effect || !text.trim()}>Rule</button>
        <button type="button" className="btn quiet" onClick={onDone}>Cancel</button></div>
    </form>
  );
}

/** The kolab's case files and its rulings: what is disputed, and the precedent (konjir_list_cases, konjir_list_rulings). */
export function CasesView({ me, tick, act, go }: { me: WebMe; tick: number; act: Act; go(r: string): void }) {
  const cases = useRead<WebCasesView>('cases?state=all', tick);
  const rulings = useRead<WebRulingsView>('rulings', tick);
  const error = cases.error ?? rulings.error;
  if (error) return <p className="empty" role="alert">{error}</p>;
  if (!cases.data || !rulings.data) return <p className="empty">Reading the case files…</p>;
  if (!cases.data.belongs) {
    return <p className="empty">Case files and rulings belong to this kolab’s work: only those with Write on a layer of it see them (D49). You hold {me.access.level ?? 'no access'} here.</p>;
  }
  const open = cases.data.cases.filter((c) => c.state === 'open');
  const settled = cases.data.cases.filter((c) => c.state !== 'open');
  const item = (c: WebCase) => <li key={c.case} className="qitem"><CaseBox c={c} me={me} act={act} go={go} /></li>;
  return (
    <>
      <section aria-labelledby="c-open"><h2 className="section-title" id="c-open">Open case files</h2>
        <p className="why-not" style={{ margin: '-6px 0 12px', maxWidth: '68ch' }}>A disagreement the two sides couldn’t settle: one position each, with its evidence, until a person with Write on its layer who isn’t a party rules. Open one from the element it is about.</p>
        {open.length ? <ul className="qlist">{open.map(item)}</ul> : <p className="empty">No open case files. Nothing is in dispute.</p>}
      </section>
      <section aria-labelledby="c-rulings"><h2 className="section-title" id="c-rulings">Rulings</h2>
        <p className="why-not" style={{ margin: '-6px 0 12px', maxWidth: '68ch' }}>Precedent in this kolab, newest first. Agents are served them, so a settled question isn’t argued again.</p>
        {rulings.data.rulings.length ? <ul className="qlist">{rulings.data.rulings.map((r) => <li key={r.ruling} className="qitem"><RulingBox ruling={r} me={me} go={go} /></li>)}</ul>
          : <p className="empty">No rulings yet.</p>}
      </section>
      {settled.length > 0 && (
        <section aria-labelledby="c-settled"><h2 className="section-title" id="c-settled">Settled case files</h2>
          <ul className="qlist">{settled.map(item)}</ul>
        </section>
      )}
    </>
  );
}
