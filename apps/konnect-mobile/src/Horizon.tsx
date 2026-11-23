/**
 * The brand's horizon: five bands, the sky from its zenith to the field (libs/brand), 3, 2, 1, 2
 * and 3 points tall, as the web draws it under its pages. Here it lies along the bottom edge of
 * the screen, over whatever is there, touching nothing: no layout moves for it, nothing under it
 * stops taking touches, and the phone's rounded corners may clip its ends.
 */
import { StyleSheet, View } from 'react-native';
import { useAppTheme } from './theme';

const BANDS = [['sky-zenith', 3], ['sky-veil', 2], ['sky-glow', 1], ['sky-horizon', 2], ['sky-field', 3]] as const;

export function Horizon() {
  const { colors } = useAppTheme();
  return (
    <View testID="horizon" pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.bar}>
      {BANDS.map(([token, height]) => <View key={token} style={{ height, backgroundColor: colors[token] }} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, bottom: 0 },
});
