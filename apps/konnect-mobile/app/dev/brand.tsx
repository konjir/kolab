import { StyleSheet, Text, View } from 'react-native';
import { Icon, ICONS, type IconName } from '@/icons';
import { FAMILIES, useAppTheme } from '@/theme';
import { Screen, Section } from '@/ui';

const WEIGHTS = { display: ['400', '600'], sans: ['400', '500', '600', '700'], mono: ['400', '500'] } as const;

/** Phase 0: every icon the plan's screens need, and each embedded face at each weight, in the current theme. */
export default function BrandSheet() {
  const { colors, name } = useAppTheme();
  return (
    <Screen title={`Brand: ${name}`}>
      <Section title={`Icons (${Object.keys(ICONS).length})`}>
        <View style={styles.grid}>
          {(Object.keys(ICONS) as IconName[]).map((n) => (
            <View key={n} style={styles.cell}>
              <Icon name={n} size={26} tintColor={colors.accent} fallback={<Text style={{ color: colors.boundary }}>missing</Text>} />
              <Text numberOfLines={1} style={[styles.label, { color: colors['ink-muted'] }]}>{n}</Text>
            </View>
          ))}
        </View>
      </Section>
      <Section title="Faces">
        {(Object.keys(WEIGHTS) as (keyof typeof WEIGHTS)[]).flatMap((face) => WEIGHTS[face].map((w) => (
          <Text key={`${face}${w}`} style={{ fontFamily: FAMILIES[face], fontWeight: w, fontSize: 18, color: colors.ink, padding: 6 }}>
            {FAMILIES[face]} {w}: Name it true. 0O1lI
          </Text>
        )))}
      </Section>
    </Screen>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: 6 },
  cell: { width: '20%', alignItems: 'center', paddingVertical: 8, gap: 4 },
  label: { fontFamily: FAMILIES.mono, fontSize: 9 },
});
