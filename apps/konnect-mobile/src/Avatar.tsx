/**
 * A member's picture: their GitHub avatar from their login (S5's Member.login), cached on disk by
 * expo-image; an agent shows its owner's, with an agent badge. Before Kolab says a login, or
 * offline with nothing cached, their initials.
 */
import type { Member } from '@konjir/types';
import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';
import { Icon } from './icons';
import { FAMILIES, useAppTheme } from './theme';

type WithLogin = Member & { login?: string | null; github_id?: number | string | null };

/** The GitHub avatar: by account id when Kolab gives it (stable across renames), else by login. */
export const avatarUrl = (m: Pick<WithLogin, 'login' | 'github_id'> | undefined, size: number) => {
  const px = Math.round(size * 3);
  if (m?.github_id) return `https://avatars.githubusercontent.com/u/${encodeURIComponent(String(m.github_id))}?s=${px}`;
  return m?.login ? `https://github.com/${encodeURIComponent(m.login)}.png?size=${px}` : undefined;
};

export function Avatar({ member, owner, size = 36 }: { member: WithLogin; owner?: WithLogin; size?: number }) {
  const { colors } = useAppTheme();
  // An agent's own entry carries its owner's login (S5); its owner's entry, when there is one, too.
  const url = avatarUrl(member.kind === 'agent' ? owner ?? member : member, size);
  const r = size / 2;
  return (
    <View style={{ width: size, height: size }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {url
        ? <Image source={url} cachePolicy="disk" style={{ width: size, height: size, borderRadius: r }} contentFit="cover" />
        : <View style={[styles.initials, { width: size, height: size, borderRadius: r, backgroundColor: colors['accent-soft'] }]}><Text style={{ fontFamily: FAMILIES.sans, fontWeight: '700', fontSize: size * 0.4, color: colors.accent }}>{member.actor.slice(0, 2).toUpperCase()}</Text></View>}
      {member.kind === 'agent' && (
        <View style={[styles.badge, { backgroundColor: colors.surface, width: size * 0.45, height: size * 0.45, borderRadius: size }]}>
          <Icon name="agent" size={size * 0.3} tintColor={colors.accent} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  initials: { alignItems: 'center', justifyContent: 'center' },
  badge: { position: 'absolute', right: -2, bottom: -2, alignItems: 'center', justifyContent: 'center' },
});
