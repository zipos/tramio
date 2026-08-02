// warsaw180Narratives — authored narration for bus 180 northbound.
//
// Segment ids follow the reducer convention `{poiId}:{lang}`.
//
// ── Authoring rules applied here ──────────────────────────────────────
//  1. One idea per stop. Target 12–22 spoken seconds; stops on the
//     Trakt Królewski are only ~250–400 m apart.
//  2. Orientation by left/right, never by compass heading — a passenger
//     cannot tell north from west from inside a bus.
//  3. No statistics as flavour. Budget percentages and bank rankings do
//     not land in the ear, do not relate to anything out of the window,
//     and go stale.
//  4. No instructions about the app itself inside the narration. A
//     "skip back for more" affordance belongs in the UI, not the voice.
//  5. Memorial material carries `tone: 'memorial'`, which slows delivery
//     and suppresses trivia. See SEGMENT_TONES below.
//
// ── Corrections applied against the original field notes ──────────────
//  • Stop order: Łazienki Królewskie → Plac Na Rozdrożu → Piękna. The
//    notes had Piękna before Plac Na Rozdrożu, and listed "Plac na
//    Rozdrożu" twice; the first of those two was in fact Łazienki
//    Królewskie, the stop at Trasa Łazienkowska.
//  • Removed the self-referential line announcing "an interchange to
//    touristic line 180" to passengers already riding line 180.
//  • Palma: the leaves were never natural, so nothing was "swapped for
//    plastic ones" — each leaf is fibreglass and resin on a steel core.
//    The Los Angeles connection is real but concerns the trunk, which
//    was built near San Diego and shipped via LA, Houston and Gdynia.
//    Source: en.wikipedia.org/wiki/Greetings_from_Jerusalem_Avenue
//  • Powązki-IV Brama: the wall alongside is the Powązki cemetery wall
//    — gate IV of the Catholic cemetery, which the stop is named after.
//    It is NOT a ghetto wall. Surviving Warsaw Ghetto wall fragments
//    stand on Sienna and Waliców. The Okopowa Jewish cemetery abuts the
//    Christian Powązki cemetery, and the true and heavier fact there is
//    the ghetto mass graves inside it.
//  • Dropped as unverified: the ministry at Plac Na Rozdrożu, "most
//    valuable real estate in the city", healthcare at 6% of budget,
//    Pekao as highest-earning bank, M2 being 100 m from Ordynacka, and
//    M4 as autonomous and longest in the masterplan. None of these are
//    checkable from a reliable source in the time available, so none of
//    them ship. Re-add via the fact-check stage of the authoring
//    pipeline, with a source URL per claim.
//  • Muranów metro station: previous correction claimed "construction
//    finally began" / "budowa zaczęła się dopiero niedawno". That was
//    wrong — the station has NOT been built and construction has NOT
//    begun. The station was provisioned in the original M1 plan, then
//    cut; trains pass through without stopping. Plac Konstytucji is the
//    same case. Both are expected to be built when the M4 interchange
//    work happens, to minimise line disruption. Reworded to state the
//    truth: never built, with hedged future expectation.
//    Source: project owner (lives in Warsaw), July 2026.
//  • Anielewicz age: was "twenty-four". Born 1919, uprising April 1943
//    → he was twenty-three. Changed to "twenty-three" / "dwadzieścia
//    trzy lata".
//    Source: https://jewishjournal.com/commentary/opinion/387482/my-greatest-hero-mordechai-anielewicz-and-the-warsaw-ghetto-uprising/
//  • Sadyba: was "z lat trzydziestych" / "a 1930s garden suburb".
//    Development began in the 1920s. Changed to "z lat dwudziestych i
//    trzydziestych" / "a 1920s and 30s garden suburb".
//    Source: https://en.wikipedia.org/wiki/Sadyba
//  • Esperanto: was "invented in this city". Esperanto was conceived in
//    Białystok; Zamenhof published the first book in Warsaw in 1887.
//    Changed to "first published in this city" / "opublikował po raz
//    pierwszy w tym mieście".
//    Source: https://en.wikipedia.org/wiki/Esperanto

import type { NarrativeResolver } from './TourRuntime';

/**
 * Delivery register for a segment.
 *
 * `memorial` marks Holocaust and cemetery material. It exists because
 * the original draft narrated POLIN, the Jewish cemetery and the ghetto
 * in the same wry, fun-fact voice as nightlife tips — which reads as
 * flippant and is the single largest reputational risk in the content.
 */
export type SegmentTone = 'standard' | 'memorial';

export interface SegmentStyle {
  readonly tone: SegmentTone;
  /** Multiplier applied to the user's chosen playback rate. */
  readonly rateMultiplier: number;
}

const MEMORIAL_STYLE: SegmentStyle = { tone: 'memorial', rateMultiplier: 0.9 };
const STANDARD_STYLE: SegmentStyle = { tone: 'standard', rateMultiplier: 1 };

/** POIs narrated in the memorial register. */
export const MEMORIAL_POI_IDS: readonly string[] = [
  'poi-muranow',
  'poi-polin',
  'poi-anielewicza',
  'poi-cmentarz-zydowski',
  'poi-niska',
  'poi-powazki-iv-brama',
];

const NARRATIVES: Record<string, string> = {
  // ── Wilanów → Śródmieście ──────────────────────────────────────────
  'poi-wilanow:pl':
    'Jedziemy na północ Traktem Królewskim — tą samą drogą, którą królowie jeździli z Wilanowa na Zamek. Po prawej, za drzewami, Wisła. Autobus miejski, nie wycieczkowy: będziemy mijać pałace, a potem miasto, które trzeba było zbudować od nowa.',
  'poi-wilanow:en':
    'We are heading north along the Royal Route — the same road the kings took from Wilanów to the Castle. The Vistula is off to your right, behind the trees. This is a scheduled city bus, not a tour coach: we will pass palaces first, then a city that had to be built again from nothing.',

  'poi-sadyba:pl':
    'Sadyba — osiedle-ogród z lat dwudziestych i trzydziestych, wciśnięte między fort z czasów rosyjskich a Wisłę. Domy niskie, ulice krzywe: to jeszcze nie miasto w wielkim stylu.',
  'poi-sadyba:en':
    'Sadyba — a 1920s and 30s garden suburb wedged between a Russian-era fort and the river. Low houses, crooked streets: the city has not started showing off yet.',

  // ── Aleje Ujazdowskie ──────────────────────────────────────────────
  'poi-lazienki:pl':
    'Po prawej Łazienki Królewskie — siedemdziesiąt sześć hektarów parku z pałacem na wodzie. Po lewej Aleje Ujazdowskie: ambasady, jedna za drugą, za wysokimi płotami.',
  'poi-lazienki:en':
    'On your right, Łazienki — seventy-six hectares of park with a palace built on the water. On your left, Aleje Ujazdowskie: embassies, one after another, behind tall fences.',

  'poi-plac-na-rozdrozu:pl':
    'Plac Na Rozdrożu. Nazwa jest starsza niż wszystko, co go dziś otacza — kiedyś zbiegały się tu drogi na skraju miasta. Teraz zbiega się tu ruch: pod nami przechodzi Trasa Łazienkowska.',
  'poi-plac-na-rozdrozu:en':
    'Plac Na Rozdrożu — the Crossroads Square. The name is older than anything now standing around it: these were roads meeting at the edge of town. Today it is traffic that meets here, with the Łazienkowska expressway passing underneath us.',

  'poi-piekna:pl':
    'Piękna. Wciąż jedziemy alejami ambasad, ale za chwilę to się skończy — przed nami Plac Trzech Krzyży i początek Nowego Światu.',
  'poi-piekna:en':
    'Piękna — literally "Beautiful Street". Still the avenue of embassies, though not for much longer: Three Crosses Square is ahead, and with it the start of Nowy Świat.',

  'poi-trzech-krzyzy:pl':
    'Plac Trzech Krzyży, z kościołem św. Aleksandra na środku jak wyspa. Od tego miejsca aż do Zamku idzie jedna ulica pod trzema nazwami — i cała reszta trasy.',
  'poi-trzech-krzyzy:en':
    "Three Crosses Square, with St Alexander's church sitting in the middle like an island. From here to the Royal Castle it is one continuous street under three different names — and it is the rest of our ride.",

  // ── Nowy Świat / Krakowskie Przedmieście ───────────────────────────
  'poi-foksal:pl':
    'Właśnie minęliśmy palmę. Stoi tam od dwa tysiące drugiego roku i nigdy nie była prawdziwa: każdy liść to włókno szklane i żywica na stalowym rdzeniu. Pień przyjechał z Kalifornii przez Los Angeles, Houston i Gdynię. Artystka postawiła ją, żeby ktoś w końcu usłyszał nazwę Aleje Jerozolimskie — i zapytał, gdzie się podziali warszawscy Żydzi. Wrócimy do tego pytania na północy.',
  'poi-foksal:en':
    'We have just passed the palm tree. It has stood there since 2002 and was never alive: every leaf is fibreglass and resin on a steel core. The trunk was built in California and shipped in via Los Angeles, Houston and Gdynia. The artist put it there so that someone would finally hear the name Jerusalem Avenue and ask where Warsaw\u2019s Jews had gone. We will come back to that question further north.',

  'poi-ordynacka:pl':
    'Ordynacka. To nieoficjalne centrum wychodzenia wieczorem — bez pretensji, bez listy gości. Jeśli to Twój kierunek, wysiądź i idź w lewo, w stronę Marszałkowskiej. Kilka minut na północ jest też przesiadka na metro M2.',
  'poi-ordynacka:en':
    'Ordynacka. This is the unofficial centre of going out in Warsaw — no pretension, no guest lists. If that is your evening, get off and walk left, towards Marszałkowska. A few minutes further north there is also a change to the M2 metro line.',

  'poi-uniwersytet:pl':
    'Po prawej brama główna Uniwersytetu Warszawskiego i kampus schowany za nią — pałac, w którym uczelnia mieszka od dwustu lat. Studenci wysiadają tu tysiącami, ale nie w sierpniu.',
  'poi-uniwersytet:en':
    'On your right, the main gate of the University of Warsaw and the campus hidden behind it — a palace the university has occupied for two centuries. Students pour out here by the thousand, though not in August.',

  'poi-bristol:pl':
    'Po prawej Pałac Prezydencki i hotel Bristol obok niego, a dalej Europejski. Po lewej ulica Karowa schodzi zakrętem w dół, nad Wisłę — jeśli masz wolne pół godziny, to najlepsze zejście do rzeki w całym mieście.',
  'poi-bristol:en':
    'On your right, the Presidential Palace with the Bristol beside it, and the Europejski a little further on. On your left, Karowa curves downhill to the Vistula — if you have half an hour spare, it is the best walk down to the river anywhere in the city.',

  'poi-plac-zamkowy:pl':
    'Plac Zamkowy: kolumna Zygmunta i Zamek Królewski, koniec Traktu Królewskiego. Wszystko, co widzisz, zostało odbudowane po wojnie z obrazów i zdjęć. Wysiądź tu, żeby przejść Stare Miasto na drugą stronę i złapać tramwaj na Pragę.',
  'poi-plac-zamkowy:en':
    "Castle Square: Sigismund's Column and the Royal Castle, the end of the Royal Route. Everything you can see was rebuilt after the war from paintings and photographs. Get off here to cross the Old Town on foot and pick up a tram to Praga.",

  'poi-kapitulna:pl':
    'Kapitulna. Objeżdżamy Stare Miasto z zewnątrz — mury, Barbakan i Nowe Miasto są kilkadziesiąt metrów w prawo, za pierwszą przecznicą.',
  'poi-kapitulna:en':
    'Kapitulna. We are skirting the Old Town from the outside — the walls, the Barbican and the New Town are a short walk to your right, past the first side street.',

  'poi-krasinskich:pl':
    'Plac Krasińskich. Sąd Najwyższy stoi na kolumnach z wypisanymi łacińskimi maksymami prawniczymi, a ulica, którą jedziemy, przechodzi pod placem. Obok pałac Krasińskich i pomnik Powstania Warszawskiego.',
  'poi-krasinskich:en':
    'Plac Krasińskich. The Supreme Court stands on columns inscribed with Latin legal maxims, and the road we are on runs underneath the square itself. Beside it, the Krasiński Palace and the Warsaw Uprising monument.',

  'poi-swietojerska:pl':
    'Świętojerska. Tu kończy się Stare Miasto i zaczyna coś zupełnie innego. Po prawej ambasada Chin. Od następnego przystanku jedziemy już przez dzielnicę, której w tysiąc dziewięćset czterdziestym piątym roku po prostu nie było.',
  'poi-swietojerska:en':
    'Świętojerska. This is where the Old Town ends and something entirely different begins. The Chinese embassy is on your right. From the next stop onwards we are driving through a district that, in 1945, simply did not exist.',

  // ── Muranów: memorial register ─────────────────────────────────────
  'poi-muranow:pl':
    'Muranów. Osiedle, które nas teraz otacza, zostało zbudowane na gruzach getta warszawskiego — dosłownie na nich, bo gruzu nigdy nie wywieziono. Ziemia pod tymi blokami jest wyżej niż była przed wojną. Tuż pod nami przechodzi linia M1, ale stacji tu nie ma: była w planach, potem ją skreślono i pociągi od tamtej pory przejeżdżają bez zatrzymywania. Plac Konstytucji to ta sama historia. Obie stacje mają powstać, gdy budowa węzła M4 zmusi do zamknięcia linii.',
  'poi-muranow:en':
    'Muranów. The housing estate around us was built on the rubble of the Warsaw Ghetto — literally on it, because the rubble was never cleared away. The ground beneath these blocks sits higher than it did before the war. The M1 metro line runs directly below us, but there is no station here: one was planned, then cut, and the trains have passed through the gap ever since. Plac Konstytucji is the same story. The plan is that both get built when the future M4 interchange justifies closing the line.',

  'poi-polin:pl':
    'Po lewej Muzeum Historii Żydów Polskich POLIN, a przed nim pomnik Bohaterów Getta. Muzeum opowiada tysiąc lat obecności, nie tylko jej koniec. Zamknięte we wtorki; na zwiedzanie trzeba liczyć trzy godziny.',
  'poi-polin:en':
    'On your left, POLIN, the Museum of the History of Polish Jews, with the Ghetto Heroes Monument standing in front of it. The museum tells a thousand years of presence, not only how it ended. Closed on Tuesdays; allow three hours.',

  'poi-anielewicza:pl':
    'Ulica Anielewicza nosi imię Mordechaja Anielewicza, który miał dwadzieścia trzy lata, kiedy dowodził powstaniem w getcie. Jego bunkier przy Miłej jest kilka przecznic stąd. Przejeżdżamy teraz ze Śródmieścia na Wolę.',
  'poi-anielewicza:en':
    'Anielewicza Street is named after Mordechai Anielewicz, who was twenty-three years old when he commanded the ghetto uprising. His bunker on Miła Street is a few blocks from here. We are now crossing from Śródmieście into Wola.',

  // ── Wola / Okopowa ─────────────────────────────────────────────────
  'poi-smocza:pl':
    'Smocza — od smoka, choć nikt nie wie którego. Nazwa przetrwała, choć z ulicy, która ją nosiła, nie zostało nic.',
  'poi-smocza:en':
    'Smocza — "Dragon Street", though nobody agrees which dragon. The name survived even though nothing of the street that carried it did.',

  'poi-esperanto:pl':
    'Ulica Esperanto, od języka, który Ludwik Zamenhof opublikował po raz pierwszy w tym mieście. Zamenhof jest pochowany kilkaset metrów stąd, na cmentarzu, do którego właśnie skręcamy.',
  'poi-esperanto:en':
    'Esperanto Street, named after the language Ludwik Zamenhof first published in this city. Zamenhof is buried a few hundred metres from here, in the cemetery we are turning towards now.',

  'poi-cmentarz-zydowski:pl':
    'Po lewej cmentarz żydowski przy Okopowej: założony w tysiąc osiemset szóstym roku, trzydzieści trzy hektary, ponad dwieście pięćdziesiąt tysięcy grobów. Są tam też mogiły zbiorowe z getta — około pięćdziesięciu tysięcy ludzi bez nazwisk i bez kamieni, oznaczone dopiero niedawno. Po prawej galeria Klif, przeznaczona do wyburzenia pod osiedle.',
  'poi-cmentarz-zydowski:en':
    'On your left, the Jewish cemetery on Okopowa: founded in 1806, thirty-three hectares, more than two hundred and fifty thousand marked graves. It also holds mass graves from the ghetto — some fifty thousand people with no names and no stones, marked only in recent years. On your right, the Klif shopping centre, due to be demolished for housing.',

  'poi-niska:pl':
    'Niska. Jedziemy wzdłuż muru cmentarza. Kilka przecznic na wschód, przy Stawkach, stał Umschlagplatz — rampa, z której wywożono ludzi z getta. Nie ma jej już; jest tam pomnik.',
  'poi-niska:en':
    'Niska. We are running alongside the cemetery wall. A few blocks east, at Stawki, stood the Umschlagplatz — the loading ramp from which people were deported out of the ghetto. It is gone; a memorial stands there now.',

  'poi-powazkowska:pl':
    'Powązkowska. Odbijamy od rzeki na zachód, w stronę Powązek. Po tej stronie miasta cmentarze zajmują więcej miejsca niż żywi.',
  'poi-powazkowska:en':
    'Powązkowska. We are turning away from the river, west towards Powązki. On this side of the city the cemeteries take up more room than the living do.',

  'poi-powazki-iv-brama:pl':
    'Mur po prawej to mur cmentarza Powązkowskiego, a przystanek nosi imię jego czwartej bramy. Nie jest to mur getta — te resztki stoją przy Siennej i Walicowie, w centrum. Ale cmentarz żydowski, który właśnie minęliśmy, przylega do Powązek bezpośrednio: dwie nekropolie, jedna ściana między nimi.',
  'poi-powazki-iv-brama:en':
    'The wall on your right is the wall of Powązki cemetery, and this stop is named after its fourth gate. It is not a ghetto wall — those fragments stand on Sienna and Waliców, back in the centre. But the Jewish cemetery we just passed abuts Powązki directly: two burial grounds with a single wall between them.',

  // ── Żoliborz: close ────────────────────────────────────────────────
  'poi-pkp-powazki:pl':
    'PKP Powązki — przesiadka na pociągi podmiejskie i na Dworzec Centralny. Jesteśmy w Żoliborzu, najmniejszej dzielnicy Warszawy, zaprojektowanej w latach dwudziestych jako miasto-ogród i wciąż tak wyglądającej. Godzina temu wsiedliśmy pod pałacem królewskim. Ten sam bilet, to samo miasto — tylko że po drodze trzeba je było raz zburzyć i zbudować jeszcze raz.',
  'poi-pkp-powazki:en':
    'PKP Powązki — change here for suburban trains and the central station. We are in Żoliborz, the smallest of Warsaw\u2019s districts, laid out in the 1920s as a garden city and still recognisably one. An hour ago we boarded outside a royal palace. Same ticket, same city — except that in between, it had to be destroyed once and built all over again.',
};

/** Resolver for the embedded 180 narratives. */
export const warsaw180NarrativeResolver: NarrativeResolver = (segmentId) =>
  NARRATIVES[segmentId] ?? null;

/** All authored segment ids (used by tests and the pack builder). */
export function warsaw180SegmentIds(): readonly string[] {
  return Object.keys(NARRATIVES);
}

/** Raw narrative map (used by the pack builder to emit Markdown). */
export function warsaw180Narratives(): Readonly<Record<string, string>> {
  return NARRATIVES;
}

function poiIdOf(segmentId: string): string {
  const idx = segmentId.lastIndexOf(':');
  return idx === -1 ? segmentId : segmentId.slice(0, idx);
}

/**
 * Delivery style for a segment. Memorial segments are spoken more
 * slowly; everything else uses the user's chosen rate unchanged.
 */
export function warsaw180SegmentStyle(segmentId: string): SegmentStyle {
  return MEMORIAL_POI_IDS.includes(poiIdOf(segmentId)) ? MEMORIAL_STYLE : STANDARD_STYLE;
}
