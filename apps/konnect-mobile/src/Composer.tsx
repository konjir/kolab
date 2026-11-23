/**
 * The composer: `@` completes people and agents, `#` channels; a count shows near the 32,000
 * character limit; Send is off when there is nothing to send or too much. A reply shows what it
 * answers, with a way to drop it. It sits above the home indicator, and on the keyboard while it is up.
 */
import { MAX_MESSAGE_TEXT, textLength } from '@konjir/types';
import { useEffect, useState } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon } from './icons';
import { complete, completing, suggestions } from './kolab/names';
import { quoteOf } from './kolab/thread';
import { FAMILIES, RADII, useAppTheme } from './theme';

/** The count shows once the message is within this many characters of the limit. */
const NEAR = 2_000;

/**
 * The space a bar at the bottom of the screen leaves under itself: the home indicator's, unless the
 * keyboard is up, which covers it.
 */
export function useBottomInset(): number {
  const insets = useSafeAreaInsets();
  const [keyboard, setKeyboard] = useState(false);
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const shown = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', () => setKeyboard(true));
    const hidden = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboard(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  return keyboard ? 0 : insets.bottom;
}

export function Composer({ people, channels, replyTo, onCancelReply, onSend, placeholder }: {
  people: string[]; channels: string[];
  replyTo?: { id: string; from: string; message: string }; onCancelReply: () => void;
  onSend: (text: string) => void; placeholder: string;
}) {
  const { colors } = useAppTheme();
  const bottom = useBottomInset();
  const [text, setText] = useState('');
  const [sel, setSel] = useState({ start: 0, end: 0 });
  const at = completing(text, sel.start);
  const options = at ? suggestions(at.query, at.kind === '@' ? people : channels) : [];
  const length = textLength(text);
  const over = length > MAX_MESSAGE_TEXT;
  const canSend = text.trim().length > 0 && !over;

  return (
    <View style={[styles.wrap, { borderTopColor: colors.line, backgroundColor: colors['surface-raised'], paddingBottom: 8 + bottom }]}>
      {options.length > 0 && at && (
        <View testID="suggestions" style={[styles.suggestions, { borderColor: colors.line, backgroundColor: colors.surface }]}>
          {options.map((name) => (
            <Pressable key={name} accessibilityRole="button" onPress={() => { const next = complete(text, at, sel.start, name); setText(next.text); setSel({ start: next.cursor, end: next.cursor }); }} style={styles.suggestion}>
              <Text style={{ fontFamily: FAMILIES.mono, color: colors.ink }}>{at.kind}{name}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {replyTo && (
        <View style={styles.reply}>
          <Icon name="reply" size={14} tintColor={colors['ink-muted']} />
          <Text numberOfLines={1} style={[styles.replyText, { color: colors['ink-muted'] }]}>Replying to {replyTo.from}: {quoteOf(replyTo.message, 60)}</Text>
          <Pressable accessibilityLabel="Don't reply" onPress={onCancelReply}><Text style={{ color: colors.accent }}>✕</Text></Pressable>
        </View>
      )}
      <View style={styles.row}>
        <TextInput testID="composer" value={text} onChangeText={setText} selection={sel} onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
          multiline placeholder={placeholder} placeholderTextColor={colors['ink-muted']} autoCapitalize="sentences"
          style={[styles.input, { color: colors.ink, borderColor: colors.line, backgroundColor: colors.surface }]} />
        <Pressable testID="send" accessibilityRole="button" accessibilityLabel="Send" disabled={!canSend} onPress={() => { onSend(text); setText(''); setSel({ start: 0, end: 0 }); }} style={{ opacity: canSend ? 1 : 0.4 }}>
          <Icon name="send" size={32} tintColor={colors.accent} />
        </Pressable>
      </View>
      {length > MAX_MESSAGE_TEXT - NEAR && (
        <Text testID="count" style={[styles.count, { color: over ? colors.boundary : colors['ink-muted'] }]}>{length.toLocaleString()} / {MAX_MESSAGE_TEXT.toLocaleString()}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: StyleSheet.hairlineWidth, padding: 8, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  input: { flex: 1, maxHeight: 140, minHeight: 40, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md, paddingHorizontal: 10, paddingVertical: 9, fontFamily: FAMILIES.sans, fontSize: 16 },
  suggestions: { borderWidth: StyleSheet.hairlineWidth, borderRadius: RADII.md },
  suggestion: { paddingHorizontal: 12, paddingVertical: 9 },
  reply: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  replyText: { flex: 1, fontFamily: FAMILIES.sans, fontSize: 13 },
  count: { alignSelf: 'flex-end', fontFamily: FAMILIES.mono, fontSize: 12 },
});
