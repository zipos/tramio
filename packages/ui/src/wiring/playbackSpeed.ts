// Allowed narration playback speeds.
// Finer than the original coarse set; UI keeps these behind a settings disclosure.
export const PLAYBACK_SPEEDS = [0.9, 1.0, 1.1] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 1.0;

export function isPlaybackSpeed(value: number): value is PlaybackSpeed {
  return (PLAYBACK_SPEEDS as readonly number[]).includes(value);
}

export function formatPlaybackSpeedLabel(speed: PlaybackSpeed): string {
  return `${speed}x`;
}
