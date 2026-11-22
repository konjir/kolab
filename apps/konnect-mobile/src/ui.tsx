/**
 * The few pieces every placeholder screen is made of, in the brand's type and colours: a screen
 * with a display-face title, a section header, a row with an icon, and a line of text.
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon, type IconName } from './icons';
import { FAMILIES, RADII, useAppTheme } from './theme';

export function Screen({ title, children, testID }: { title: string; children: ReactNode; testID?: string }) {
  const { colors } = useAppTheme();
  return (
    <ScrollView testID={testID} style={{ backgroundColor: colors.surface }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.screen}>
      <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{title}</Text>
      {children}
    </ScrollView>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.section}>
      <Text accessibilityRole="header" style={[styles.sectionTitle, { color: colors['ink-muted'] }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: colors['surface-raised'], borderColor: colors.line }]}>{children}</View>
    </View>
  );
}

export function Row({ icon, label, detail, onPress }: { icon: IconName; label: string; detail?: string; onPress?: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Pressable onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors['accent-soft'] }]}>
      <Icon name={icon} size={20} tintColor={colors.accent} />
      <Text style={[styles.rowLabel, { color: colors.ink }]}>{label}</Text>
      {detail !== undefined && <Text style={[styles.rowDetail, { color: colors['ink-muted'] }]}>{detail}</Text>}
    </Pressable>
  );
}

export function Body({ children, mono }: { children: ReactNode; mono?: boolean }) {
  const { colors } = useAppTheme();
  return <Text style={[mono ? styles.mono : styles.body, { color: colors['ink-muted'] }]}>{children}</Text>;
}

/** A line of text inside a Section's card: what will be listed there. */
export function Hint({ children }: { children: ReactNode }) {
  const { colors } = useAppTheme();
  return <Text style={[styles.body, styles.hint, { color: colors['ink-muted'] }]}>{children}</Text>;
}

/** Said at the top of every tab until sign-in exists, so no placeholder passes for the real thing. */
export const NOT_YET = 'Sign-in comes next: this build can\'t sign in to a team yet, so nothing here is real. This tab shows where things will go.';

export function NotYet() {
  const { colors } = useAppTheme();
  return (
    <View testID="not-yet" style={[styles.notYet, { backgroundColor: colors['accent-soft'], borderColor: colors.stale }]}>
      <Icon name="signIn" size={20} tintColor={colors.stale} />
      <Text style={[styles.notYetText, { color: colors.ink }]}>{NOT_YET}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 20 },
  hint: { paddingHorizontal: 14, paddingVertical: 12 },
  notYet: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'flex-start' },
  notYetText: { flex: 1, fontFamily: FAMILIES.sans, fontWeight: '500', fontSize: 15, lineHeight: 21 },
  title: { fontFamily: FAMILIES.display, fontWeight: '600', fontSize: 32 },
  section: { gap: 8 },
  sectionTitle: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6 },
  card: { borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowLabel: { flex: 1, fontFamily: FAMILIES.sans, fontWeight: '500', fontSize: 16 },
  rowDetail: { fontFamily: FAMILIES.mono, fontSize: 13 },
  body: { fontFamily: FAMILIES.sans, fontWeight: '400', fontSize: 15, lineHeight: 22 },
  mono: { fontFamily: FAMILIES.mono, fontWeight: '400', fontSize: 13, lineHeight: 19 },
});
