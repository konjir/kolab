/**
 * The few pieces every placeholder screen is made of, in the brand's type and colours: a screen
 * with a display-face title, a section header, a row with an icon, and a line of text.
 */
import type { ComponentProps, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Icon, type IconName } from './icons';
import { buttonCorners, FAMILIES, RADII, useAppTheme } from './theme';

/** A screen: its title in the display face (or `header`, in its place), then what it holds. */
export function Screen({ title, header, children, testID, refreshControl }: { title?: string; header?: ReactNode; children: ReactNode; testID?: string; refreshControl?: ComponentProps<typeof ScrollView>['refreshControl'] }) {
  const { colors } = useAppTheme();
  return (
    <ScrollView testID={testID} refreshControl={refreshControl} keyboardShouldPersistTaps="handled" style={{ backgroundColor: colors.surface }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.screen}>
      {header ?? (title !== undefined && <Text accessibilityRole="header" style={[styles.title, { color: colors.ink }]}>{title}</Text>)}
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

/**
 * A row of a card: an icon, a label and, at the right, a detail. One that opens something has a
 * chevron; `destructive` is in the boundary colour, for what removes or ends something.
 */
export function Row({ icon, label, detail, onPress, testID, chevron, destructive }: { icon: IconName; label: string; detail?: string; onPress?: () => void; testID?: string; chevron?: boolean; destructive?: boolean }) {
  const { colors } = useAppTheme();
  const tint = destructive ? colors.boundary : colors.accent;
  return (
    <Pressable testID={testID} accessibilityRole={onPress ? "button" : undefined} onPress={onPress} disabled={!onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors['accent-soft'] }]}>
      <Icon name={icon} size={20} tintColor={tint} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text style={[styles.rowLabel, { color: destructive ? colors.boundary : colors.ink }]}>{label}</Text>
      {detail !== undefined && <Text numberOfLines={1} style={[styles.rowDetail, { color: colors['ink-muted'] }]}>{detail}</Text>}
      {chevron && <Icon name="chevron" size={14} tintColor={colors['ink-muted']} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
    </Pressable>
  );
}

/** A row with a switch at the right: on or off, saved as it changes. */
export function SwitchRow({ icon, label, value, onChange, testID, busy }: { icon: IconName; label: string; value: boolean; onChange: (on: boolean) => void; testID?: string; busy?: boolean }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.row}>
      <Icon name={icon} size={20} tintColor={colors.accent} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text style={[styles.rowLabel, { color: colors.ink }]}>{label}</Text>
      <Switch testID={testID} accessibilityLabel={label} value={value} disabled={busy} onValueChange={onChange}
        trackColor={{ true: colors.accent, false: colors.line }} thumbColor={colors.surface} ios_backgroundColor={colors.line} />
    </View>
  );
}

/** One of a few choices, ticked when chosen, as iOS's settings lists them. */
export function ChoiceRow({ label, chosen, onPress, testID }: { label: string; chosen: boolean; onPress: () => void; testID?: string }) {
  const { colors } = useAppTheme();
  return (
    <Pressable testID={testID} accessibilityRole="radio" accessibilityState={{ checked: chosen }} onPress={onPress} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors['accent-soft'] }]}>
      <Text style={[styles.rowLabel, { color: colors.ink }]}>{label}</Text>
      {chosen && <Icon name="check" size={18} tintColor={colors.accent} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />}
    </Pressable>
  );
}

/** A count in a pill: what is unread and for you (a mention, or a direct message). */
export function Badge({ count, more }: { count: number; more?: boolean }) {
  const { colors } = useAppTheme();
  if (!count) return null;
  return <View style={[styles.badge, { backgroundColor: colors.boundary }]}><Text style={[styles.badgeText, { color: colors['on-accent'] }]}>{count}{more ? '+' : ''}</Text></View>;
}

/**
 * A row of a list of conversations, Slack's way: a picture at the left, the name (bold when
 * something is unread), one line of what was said last under it, and the time and a badge at the
 * right. `subTone` colours that line: `alert` for what needs you.
 */
export function ListRow({ leading, title, subtitle, subTone, time, unread, badge, badgeMore, onPress, testID, accessibilityLabel }: {
  leading: ReactNode; title: string; subtitle?: string; subTone?: 'alert'; time?: string; unread?: boolean; badge?: number; badgeMore?: boolean;
  onPress: () => void; testID?: string; accessibilityLabel?: string;
}) {
  const { colors } = useAppTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? [title, subtitle, time, badge ? `${badge}${badgeMore ? '+' : ''} unread` : undefined].filter(Boolean).join(', ')} onPress={onPress}
      style={({ pressed }) => [styles.list, pressed && { backgroundColor: colors['accent-soft'] }]}>
      {leading}
      <View style={styles.listText}>
        <View style={styles.listTop}>
          <Text numberOfLines={1} style={[styles.listTitle, { color: unread ? colors.ink : colors['ink-muted'], fontWeight: unread ? '700' : '500' }]}>{title}</Text>
          {time && <Text style={[styles.listTime, { color: colors['ink-muted'] }]}>{time}</Text>}
        </View>
        {(subtitle || !!badge) && (
          <View style={styles.listTop}>
            <Text numberOfLines={1} style={[styles.listSub, { color: subTone === 'alert' ? colors.boundary : colors['ink-muted'], fontWeight: subTone === 'alert' ? '600' : '400' }]}>{subtitle ?? ''}</Text>
            <Badge count={badge ?? 0} more={badgeMore} />
          </View>
        )}
      </View>
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

/** Said on a tab whose conversations aren't built yet, so no placeholder passes for the real thing. */
export const NOT_BUILT = 'Not built yet: conversations come next. This tab shows where they will go.';

/** A notice in the brand's "stale" colour: something that isn't there yet, or needs doing first. */
export function Notice({ children, icon = 'signIn' }: { children: ReactNode; icon?: IconName }) {
  const { colors } = useAppTheme();
  return (
    <View testID="notice" style={[styles.notYet, { backgroundColor: colors['accent-soft'], borderColor: colors.stale }]}>
      <Icon name={icon} size={20} tintColor={colors.stale} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
      <Text style={[styles.notYetText, { color: colors.ink }]}>{children}</Text>
    </View>
  );
}

export function NotBuilt() {
  return <Notice icon="update">{NOT_BUILT}</Notice>;
}

/** A button in the accent colour, or quieter (`quiet`), disabled while `busy`. */
export function Button({ label, onPress, busy, quiet, testID }: { label: string; onPress: () => void; busy?: boolean; quiet?: boolean; testID?: string }) {
  const { colors } = useAppTheme();
  return (
    <Pressable testID={testID} accessibilityRole="button" onPress={onPress} disabled={busy}
      style={({ pressed }) => [styles.button, quiet ? { borderColor: colors['line-strong'], borderWidth: 1 } : { backgroundColor: colors.accent, borderColor: colors.accent, borderWidth: 1 }, (pressed || busy) && { opacity: 0.6 }]}>
      <Text style={[styles.buttonLabel, { color: quiet ? colors.ink : colors['on-accent'] }]}>{busy ? `${label}…` : label}</Text>
    </Pressable>
  );
}

/** What went wrong, in the brand's "boundary" colour. */
export function Problem({ children }: { children: ReactNode }) {
  const { colors } = useAppTheme();
  return <Text accessibilityRole="alert" style={[styles.body, { color: colors.boundary }]}>{children}</Text>;
}

const BUTTON_HEIGHT = 44;

const styles = StyleSheet.create({
  screen: { padding: 16, gap: 20 },
  hint: { paddingHorizontal: 14, paddingVertical: 12 },
  // The brand's button: the web's corners, at a height a thumb finds.
  button: { height: BUTTON_HEIGHT, ...buttonCorners(BUTTON_HEIGHT), paddingHorizontal: 18, alignItems: 'center', justifyContent: 'center' },
  buttonLabel: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 16 },
  notYet: { flexDirection: 'row', gap: 12, padding: 14, borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, alignItems: 'flex-start' },
  notYetText: { flex: 1, fontFamily: FAMILIES.sans, fontWeight: '500', fontSize: 15, lineHeight: 21 },
  title: { fontFamily: FAMILIES.display, fontWeight: '700', fontSize: 34, letterSpacing: 0.37 },
  section: { gap: 8 },
  sectionTitle: { fontFamily: FAMILIES.sans, fontWeight: '600', fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.6 },
  card: { borderRadius: RADII.md, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12 },
  rowLabel: { flex: 1, fontFamily: FAMILIES.sans, fontWeight: '500', fontSize: 16 },
  rowDetail: { fontFamily: FAMILIES.sans, fontSize: 15, maxWidth: '55%' },
  badge: { minWidth: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  badgeText: { fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: 12 },
  list: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 10 },
  listText: { flex: 1, gap: 2 },
  listTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  listTitle: { flex: 1, fontFamily: FAMILIES.sans, fontSize: 16 },
  listTime: { fontFamily: FAMILIES.sans, fontSize: 12 },
  listSub: { flex: 1, fontFamily: FAMILIES.sans, fontSize: 14 },
  body: { fontFamily: FAMILIES.sans, fontWeight: '400', fontSize: 15, lineHeight: 22 },
  mono: { fontFamily: FAMILIES.mono, fontWeight: '400', fontSize: 13, lineHeight: 19 },
});
