// Allowed narration playback speeds (Requirement 16.4).
export const PLAYBACK_SPEEDS = [0.75, 1.0, 1.25, 1.5] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 1.0;

export function isPlaybackSpeed(value: number): value is PlaybackSpeed {
  return (PLAYBACK_SPEEDS as readonly number[]).includes(value);
}

export function formatPlaybackSpeedLabel(speed: PlaybackSpeed): string {
  return `${speed}x`;
}
