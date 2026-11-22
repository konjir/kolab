/** Konjir's wordmark, drawn from libs/brand's geometry (WORDMARK), the one the site and the web app draw, in the theme's colours. */
import { WORDMARK } from '@konjir/brand';
import Svg, { Circle, G, Path } from 'react-native-svg';
import { useAppTheme } from './theme';

export function Wordmark({ height = 56 }: { height?: number }) {
  const { colors } = useAppTheme();
  const width = (height * WORDMARK.width) / WORDMARK.height;
  return (
    <Svg testID="wordmark" accessibilityRole="image" accessibilityLabel="Konjir" width={width} height={height} viewBox={WORDMARK.viewBox}>
      <G fill="none" stroke={colors.ink} strokeWidth={WORDMARK.strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        {WORDMARK.letters.map((d) => <Path key={d} d={d} />)}
      </G>
      <Circle cx={WORDMARK.sun.cx} cy={WORDMARK.sun.cy} r={WORDMARK.sun.r} fill={colors.sun} />
      <Path d={WORDMARK.moon} fill={colors.moon} stroke={colors.moon} strokeWidth={0.6} strokeLinejoin="round" />
    </Svg>
  );
}
