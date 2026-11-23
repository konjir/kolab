/**
 * The header's buttons: back, a chevron in the ink colour that VoiceOver calls "Back", and Cancel,
 * which closes a sheet (New message, Forward) without doing anything.
 */
import { router } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { Icon } from './icons';
import { FAMILIES, useAppTheme } from './theme';

export function BackButton() {
  const { colors } = useAppTheme();
  return (
    <Pressable testID="back" accessibilityRole="button" accessibilityLabel="Back" hitSlop={12} onPress={() => router.back()} style={styles.button}>
      <Icon name="back" size={20} tintColor={colors.ink} weight="semibold" />
    </Pressable>
  );
}

export function CancelButton() {
  const { colors } = useAppTheme();
  return (
    <Pressable testID="cancel" accessibilityRole="button" hitSlop={12} onPress={() => router.back()} style={styles.button}>
      <Text style={[styles.cancel, { color: colors.accent }]}>Cancel</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { paddingVertical: 4, paddingRight: 8 },
  cancel: { fontFamily: FAMILIES.sans, fontWeight: '500', fontSize: 16 },
});
