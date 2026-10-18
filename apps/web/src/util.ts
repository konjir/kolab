/** How long ago, in words. */
export function ago(at: string, now = Date.now()): string {
  const m = Math.round((now - new Date(at).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export type DiffPart = { kind: 'same' | 'del' | 'ins'; text: string };

/** A word-level diff of `a` into `b`, longest common subsequence first. */
export function wordDiff(a: string, b: string): DiffPart[] {
  const x = a.split(/(\s+)/), y = b.split(/(\s+)/);
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last && last.kind === kind) last.text += text; else out.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { push('same', x[i]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) push('del', x[i++]);
    else push('ins', y[j++]);
  }
  while (i < n) push('del', x[i++]);
  while (j < m) push('ins', y[j++]);
  return out.filter((p) => p.text);
}

/** The next free element ID: the prefix most IDs share, and one past the highest number. */
export function nextElementId(ids: string[], fallback: string): string {
  const parsed = ids.map((id) => /^([A-Za-z]+)(\d+)$/.exec(id)).filter((m): m is RegExpExecArray => !!m);
  const counts = new Map<string, number>();
  for (const m of parsed) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  const prefix = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? fallback;
  const max = Math.max(0, ...parsed.filter((m) => m[1] === prefix).map((m) => Number(m[2])));
  let next = max + 1;
  while (ids.includes(`${prefix}${next}`)) next++;
  return `${prefix}${next}`;
}

export const addr = (node: string, seq?: number | null, element?: string | null) =>
  `kj:${node}${seq ? `@${seq}` : ''}${element ? `#${element}` : ''}`;
