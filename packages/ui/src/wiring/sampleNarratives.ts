// sampleNarratives — embedded narrative text for the demo / pack fallback route.
//
// Delegates to the authored bus 180 content. Kept as a stable indirection
// so the runtime and the hook do not need to know which route is current.

import type { NarrativeResolver } from './TourRuntime';
import {
  warsaw180NarrativeResolver,
  warsaw180Narratives,
  warsaw180SegmentStyle,
  type SegmentStyle,
} from './warsaw180Narratives';

/** Resolver for embedded demo narratives. */
export const sampleNarrativeResolver: NarrativeResolver = warsaw180NarrativeResolver;

/** Delivery style (register / rate) for the current embedded route. */
export function sampleSegmentStyle(segmentId: string): SegmentStyle {
  return warsaw180SegmentStyle(segmentId);
}

/** Caption text for the segment currently playing (or null if unknown). */
export function resolveNarrativeCaption(
  segmentId: string | null,
  extra: Readonly<Record<string, string>> = {},
): string | null {
  if (segmentId === null) return null;
  return extra[segmentId] ?? warsaw180Narratives()[segmentId] ?? null;
}
