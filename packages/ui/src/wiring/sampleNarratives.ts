// sampleNarratives — embedded narrative text for the demo / pack fallback route.

import type { NarrativeResolver } from './TourRuntime';

const NARRATIVES: Record<string, string> = {
  'poi-stadion-narodowy:pl':
    'PGE Narodowy — stadion zbudowany na ruinach dziesięcioleci. Z okna tramwaju widać jego charakterystyczną konstrukcję.',
  'poi-powisle:pl': 'Zbliżamy się do Wisły. Ten odcinek Alei Jerozolimskich łączy centrum z Pragą.',
  'poi-starynkiewicza:pl':
    'Koniec trasy letniej — Plac Starynkiewicza. Do początku sierpnia linia 22 kończy tu kurs z powodu remontu torowiska na placu Zawiszy.',
  'poi-stadion-narodowy:en':
    'PGE Narodowy — a stadium built on decades of history. From the tram window you can see its distinctive structure.',
  'poi-powisle:en':
    'We are approaching the Vistula. This stretch of Aleje Jerozolimskie links the centre with Praga.',
  'poi-starynkiewicza:en':
    'End of the summer route — Plac Starynkiewicza. Until early August, line 22 terminates here due to track works at Plac Zawiszy.',
};

/** Resolver for embedded demo narratives. */
export const sampleNarrativeResolver: NarrativeResolver = (segmentId) =>
  NARRATIVES[segmentId] ?? null;

/** Caption text for the segment currently playing (or null if unknown). */
export function resolveNarrativeCaption(
  segmentId: string | null,
  extra: Readonly<Record<string, string>> = {},
): string | null {
  if (segmentId === null) return null;
  return extra[segmentId] ?? NARRATIVES[segmentId] ?? null;
}
