/** A screen that runs a spike once, showing each line it logs, and printing it to Metro's log too. */
import { useEffect, useState } from 'react';
import { Body, Screen } from '@/ui';

export function LogScreen({ title, tag, run }: { title: string; tag: string; run: (log: (line: string) => void) => Promise<unknown> }) {
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    const log = (line: string) => { console.log(`[${tag}] ${line}`); setLines((l) => [...l, line]); };
    run(log).catch((e: unknown) => log(`FAILED: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`));
  }, [run, tag]);
  return (
    <Screen title={title}>
      {lines.map((l, i) => <Body key={i} mono>{l}</Body>)}
    </Screen>
  );
}
