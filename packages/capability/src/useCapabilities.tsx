/**
 * `useCapabilities` hook + `CapabilityProvider` (task 9.2).
 *
 * Per Requirements 15.2 / 15.3 / 15.4 and design.md "Capability_Layer" /
 * "Capability Layer Strategy", the Tour_Engine and command translators
 * consume **flags**, not OS versions. This file exposes those flags to React
 * code via a context that is resolved **once at boot** by an injected probe
 * function and then held immutable for the lifetime of the session.
 *
 * Recommended consumption pattern (mirrors design.md):
 *
 *     // App entry. probeCapabilities() comes from task 9.1.
 *     import { Platform } from 'react-native';
 *     import {
 *       CapabilityProvider,
 *       probeCapabilities,
 *     } from '@tramio/capability';
 *
 *     const caps = probeCapabilities(
 *       Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'unknown',
 *       typeof Platform.Version === 'number' ? Platform.Version : parseInt(String(Platform.Version), 10),
 *       /* native probe results from tasks 8.x *\/ undefined,
 *     );
 *
 *     export default function App() {
 *       return (
 *         <CapabilityProvider value={caps}>
 *           <Root />
 *         </CapabilityProvider>
 *       );
 *     }
 *
 *     // Anywhere downstream:
 *     function useArmGeofences() {
 *       const caps = useCapabilities();
 *       return dispatchByCapability(caps, {
 *         regionMonitoringV2: { modern: armV2, fallback: armLegacy },
 *       });
 *     }
 *
 * Translators MUST consume `useCapabilities()` and feed its result into
 * `dispatchByCapability`. They MUST NOT read `Platform.OS` or
 * `Platform.Version` directly — that is the single rule task 9.2 exists to
 * enforce.
 *
 * The provider intentionally accepts the resolved `Capabilities` value as a
 * prop rather than running a probe inside a `useState` initializer. That
 * keeps the React layer pure: the tree at the entry point owns when (and
 * with what inputs) the probe runs, and tests can pass a fixed
 * `Capabilities` snapshot without faking React Native modules.
 */
import { createContext, useContext } from 'react';
import type { ReactElement, ReactNode } from 'react';

import { defaultCapabilities } from './probes';
import type { Capabilities } from './types';

/**
 * Context value. Default is the conservative baseline so that a translator
 * accidentally rendered outside `<CapabilityProvider>` still picks fallback
 * paths (Req 15.4: never degrade active-tour functionality below the
 * documented fallback).
 */
const CapabilityContext = createContext<Capabilities>(defaultCapabilities());

CapabilityContext.displayName = 'CapabilityContext';

/**
 * Props for `CapabilityProvider`. The provider takes a fully-resolved
 * `Capabilities` snapshot built by `probeCapabilities()` once at app start,
 * or a fixed snapshot built by tests.
 */
export interface CapabilityProviderProps {
  /** Frozen `Capabilities` snapshot. */
  readonly value: Capabilities;
  readonly children: ReactNode;
}

/**
 * Provider wrapping the React tree with a fixed `Capabilities` snapshot.
 * Intended to be mounted exactly once at app boot (or once per test).
 */
export function CapabilityProvider(props: CapabilityProviderProps): ReactElement {
  return (
    <CapabilityContext.Provider value={props.value}>{props.children}</CapabilityContext.Provider>
  );
}

/**
 * Read the current `Capabilities` snapshot from React context.
 *
 * Translators consume this value via `dispatchByCapability(caps, ...)`. The
 * returned record is frozen by `probeCapabilities()` / `defaultCapabilities()`,
 * so callers can rely on referential and value stability for the lifetime of
 * the provider.
 */
export function useCapabilities(): Capabilities {
  return useContext(CapabilityContext);
}
