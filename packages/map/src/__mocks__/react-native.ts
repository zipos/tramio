/**
 * Minimal react-native mock for Jest tests in the @tramio/map package.
 *
 * Provides just enough of the react-native API surface for the OfflineMap
 * component to render in a node test environment.
 */

import React from 'react';

export function View(props: Record<string, unknown>) {
  return React.createElement('View', props, props.children as React.ReactNode);
}

export const StyleSheet = {
  create: <T extends Record<string, Record<string, unknown>>>(styles: T): T => styles,
};

export type ViewStyle = Record<string, unknown>;
