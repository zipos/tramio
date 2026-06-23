// sampleNarratives — embedded narrative text for the bundled demo route.
//
// The full pipeline reads narrative Markdown from a downloaded Offline_Pack
// via Storage_Manager. For the MVP demo APK there is no download step, so
// the Warsaw Tram 22 East narratives are embedded here and exposed through
// a `NarrativeResolver` keyed by the reducer's `{poiId}:{lang}` segment id.
//
// NOTE: coordinates + text are placeholder demo content. Replace with
// surveyed POI data and authored copy before any release.

import type { NarrativeResolver } from './TourRuntime';

const NARRATIVES: Record<string, string> = {
  'poi-pkin:pl':
    'Pałac Kultury i Nauki to najwyższy budynek w Polsce, wzniesiony w 1955 roku. ' +
    'Ma 237 metrów wysokości wraz z iglicą. Na trzydziestym piętrze znajduje się ' +
    'taras widokowy z panoramą całej Warszawy.',
  'poi-pkin:en':
    'The Palace of Culture and Science is the tallest building in Poland, completed ' +
    'in 1955. It stands 237 meters tall including its spire. The thirtieth floor ' +
    'offers an observation terrace with a panorama of all Warsaw.',
  'poi-muzeum-narodowe:pl':
    'Muzeum Narodowe w Warszawie to jedna z największych galerii sztuki w Polsce. ' +
    'W zbiorach znajdują się dzieła od starożytności po sztukę współczesną, w tym ' +
    'słynna Bitwa pod Grunwaldem Jana Matejki.',
  'poi-muzeum-narodowe:en':
    'The National Museum in Warsaw is one of the largest art galleries in Poland. ' +
    'Its collection spans antiquity to contemporary art, including Jan Matejko\u2019s ' +
    'famous painting, the Battle of Grunwald.',
  'poi-stadion-narodowy:pl':
    'Stadion Narodowy, zwany PGE Narodowy, otwarto w 2012 roku na Euro. Mieści ' +
    'prawie pięćdziesiąt osiem tysięcy widzów, a jego biało-czerwona fasada ' +
    'nawiązuje do barw narodowych.',
  'poi-stadion-narodowy:en':
    'The National Stadium, known as PGE Narodowy, opened in 2012 for the European ' +
    'Championship. It seats nearly fifty-eight thousand spectators, and its ' +
    'red-and-white facade echoes the national colors.',
};

/** Resolver for the embedded demo narratives. */
export const sampleNarrativeResolver: NarrativeResolver = (segmentId) =>
  NARRATIVES[segmentId] ?? null;
