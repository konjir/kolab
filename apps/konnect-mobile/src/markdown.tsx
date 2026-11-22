/**
 * Agents write markdown; this draws the common part of it, with no dependency: paragraphs,
 * headings, `-`/`*`/`1.` lists, ``` fenced code, > quotes, and inline **bold**, *italic*, `code` and
 * [links](https://…). Links open in the browser. Anything else shows as written.
 */
import * as WebBrowser from 'expo-web-browser';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import type { Palette } from '@konjir/brand';
import { FAMILIES, RADII } from './theme';

export type Block =
  | { type: 'p'; text: string } | { type: 'h'; level: number; text: string } | { type: 'code'; text: string }
  | { type: 'li'; ordered: boolean; n: number; text: string } | { type: 'quote'; text: string };

/** Markdown into blocks, line by line. */
export function blocksOf(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  const flush = () => { if (para.length) out.push({ type: 'p', text: para.join(' ') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) code.push(lines[i]!);
      out.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    let m: RegExpExecArray | null;
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); out.push({ type: 'h', level: m[1]!.length, text: m[2]! }); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) { flush(); out.push({ type: 'li', ordered: false, n: 0, text: m[1]! }); continue; }
    if ((m = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) { flush(); out.push({ type: 'li', ordered: true, n: Number(m[1]), text: m[2]! }); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flush(); out.push({ type: 'quote', text: m[1]! }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}

export type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string };

/** Inline markdown into spans. */
export function spansOf(text: string): Span[] {
  const out: Span[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push({ text: text.slice(last, m.index) });
    const t = m[0];
    if (m[1]) out.push({ text: t.slice(1, -1), code: true });
    else if (m[2]) out.push({ text: t.slice(2, -2), bold: true });
    else if (m[3]) out.push({ text: t.slice(1, -1), italic: true });
    else out.push({ text: /^\[([^\]]+)\]/.exec(t)![1]!, href: m[5] });
    last = m.index! + t.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function Inline({ text, colors, size }: { text: string; colors: Palette; size: number }): ReactNode {
  return spansOf(text).map((s, i) => (
    <Text key={i} onPress={s.href ? () => void WebBrowser.openBrowserAsync(s.href!) : undefined}
      style={{ fontWeight: s.bold ? '700' : undefined, fontStyle: s.italic ? 'italic' : undefined, fontFamily: s.code ? FAMILIES.mono : undefined, fontSize: s.code ? size - 2 : undefined, color: s.href ? colors.accent : undefined, textDecorationLine: s.href ? 'underline' : undefined, backgroundColor: s.code ? colors['surface-sunken'] : undefined }}>
      {s.text}
    </Text>
  ));
}

export function Markdown({ source, colors, size = 16 }: { source: string; colors: Palette; size?: number }) {
  const base = { fontFamily: FAMILIES.sans, fontSize: size, lineHeight: size * 1.4, color: colors.ink };
  return (
    <View style={{ gap: 6 }}>
      {blocksOf(source).map((b, i) => {
        switch (b.type) {
          case 'code': return <Text key={i} selectable style={{ fontFamily: FAMILIES.mono, fontSize: size - 3, color: colors.ink, backgroundColor: colors['surface-sunken'], padding: 8, borderRadius: RADII.md }}>{b.text}</Text>;
          case 'h': return <Text key={i} style={{ ...base, fontFamily: FAMILIES.display, fontWeight: '600', fontSize: size + Math.max(0, 6 - b.level * 2) }}><Inline text={b.text} colors={colors} size={size} /></Text>;
          case 'li': return <Text key={i} style={base}>{b.ordered ? `${b.n}. ` : '• '}<Inline text={b.text} colors={colors} size={size} /></Text>;
          case 'quote': return <Text key={i} style={{ ...base, color: colors['ink-muted'], borderLeftWidth: 3, borderLeftColor: colors.line, paddingLeft: 8 }}><Inline text={b.text} colors={colors} size={size} /></Text>;
          default: return <Text key={i} style={base}><Inline text={b.text} colors={colors} size={size} /></Text>;
        }
      })}
    </View>
  );
}
