// ErrorBoundary — Catches render errors during a pocketed tour.
//
// Without this, a render throw produces a white screen the rider won't
// discover for twenty minutes. The boundary shows a recovery screen with
// a retry action and invokes `onTourCleanup` so GPS and audio are released
// rather than leaked.
//
// @see FIX 6 in the UX spec.

import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

export interface ErrorBoundaryProps {
  children: ReactNode;
  /** Called when an error is caught and a tour may be in progress. */
  onTourCleanup?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // End any in-progress tour to release GPS/audio resources.
    this.props.onTourCleanup?.();
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title} accessibilityRole="header">
            Something went wrong
          </Text>
          <Text style={styles.body}>
            The app encountered an unexpected error. Your tour has been stopped to save battery.
          </Text>
          <TouchableOpacity
            style={styles.retryButton}
            onPress={this.handleRetry}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1a1a1a',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    fontSize: 15,
    color: '#374151',
    lineHeight: 22,
    textAlign: 'center',
    marginBottom: 24,
    maxWidth: 320,
  },
  retryButton: {
    backgroundColor: '#2563eb',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 8,
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryButtonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
});
