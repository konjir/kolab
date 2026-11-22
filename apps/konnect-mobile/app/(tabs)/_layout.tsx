import { NativeTabs } from 'expo-router/native-tabs';
import { ICONS } from '@/icons';
import { useAppTheme } from '@/theme';

/** The four tabs, native on each platform: Home, DMs, Activity and You. */
export default function TabsLayout() {
  const { colors } = useAppTheme();
  return (
    <NativeTabs tintColor={colors.accent} backgroundColor={colors['surface-raised']}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: ICONS.home.ios, selected: ICONS.homeSelected.ios }} md={ICONS.home.android} />
        <NativeTabs.Trigger.Label>Home</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="dms">
        <NativeTabs.Trigger.Icon sf={{ default: ICONS.dms.ios, selected: ICONS.dmsSelected.ios }} md={ICONS.dms.android} />
        <NativeTabs.Trigger.Label>DMs</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="activity">
        <NativeTabs.Trigger.Icon sf={{ default: ICONS.activity.ios, selected: ICONS.activitySelected.ios }} md={ICONS.activity.android} />
        <NativeTabs.Trigger.Label>Activity</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="you">
        <NativeTabs.Trigger.Icon sf={{ default: ICONS.you.ios, selected: ICONS.youSelected.ios }} md={ICONS.you.android} />
        <NativeTabs.Trigger.Label>You</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
