// MidRouteBoardingNotice — Brief non-blocking notice for mid-route boarding.
//
// When a rider boards at a stop other than the first, several POIs are
// already behind them and will never trigger. This component explains that
// without blocking playback.
//
// @see FIX 7 in the UX spec.

import type { ReactElement } from 'react';
import { StyleSheet, Text, View } from 'react-native';

export interface MidRouteBoardingNoticeProps {
  behindCount: number;
  aheadCount: number;
  nextPoiName: string;
}

export function MidRouteBoardingNotice({
  behindCount,
  aheadCount,
  nextPoiName,
}: MidRouteBoardingNoticeProps): ReactElement {
  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLabel={`You boarded mid-route. ${behindCount} landmark${behindCount !== 1 ? 's' : ''} are behind you. ${aheadCount} ahead, starting with ${nextPoiName}.`}
    >
      <Text style={styles.text}>
        You boarded mid-route — {behindCount} landmark{behindCount !== 1 ? 's' : ''} already passed.{' '}
        {aheadCount} ahead, next up: <Text style={styles.bold}>{nextPoiName}</Text>.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: '100%',
    backgroundColor: '#eff6ff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: '#bfdbfe',
  },
  text: {
    fontSize: 13,
    color: '#1e40af',
    lineHeight: 18,
  },
  bold: {
    fontWeight: '600',
  },
});
