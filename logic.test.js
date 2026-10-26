// Run: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const NTT = require("./logic.js");

function seeded(seed = 42) {
  return () => ((seed = (seed * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32);
}

const song = (id, trackName, artistName = "A", extra = {}) => ({
  kind: "song", trackId: id, trackName, artistName,
  previewUrl: `https://audio.example/${id}.m4a`, artworkUrl100: "https://img/100x100bb.jpg", ...extra,
});

test("cleanTitle strips remaster/live/feat noise", () => {
  assert.equal(NTT.cleanTitle("Let It Be (Remastered 2009)"), "Let It Be");
  assert.equal(NTT.cleanTitle("Hey Jude - 2015 Mix"), "Hey Jude");
  assert.equal(NTT.cleanTitle("Song [feat. X] (Live)"), "Song");
  assert.equal(NTT.cleanTitle(undefined), "");
});

test("normalizeTracks drops non-songs, missing/insecure previews, and duplicates", () => {
  const out = NTT.normalizeTracks([
    song(1, "Hey Jude"),
    song(2, "Hey Jude - 2015 Mix"),               // duplicate after cleaning
    song(3, "Hey Jude", "Other Artist"),           // same title, different artist: kept
    { ...song(4, "Video"), kind: "music-video" },
    { ...song(5, "No Preview"), previewUrl: undefined },
    { ...song(6, "Insecure"), previewUrl: "http://x/6.m4a" },
  ]);
  assert.deepEqual(out.map((t) => t.id), [1, 3]);
  assert.equal(out[0].artworkUrl, "https://img/400x400bb.jpg");
});

test("normalizeTracks keeps the studio original when live and studio versions both appear", () => {
  const live = song(1, "Hotel California (Live)", "Eagles", { collectionName: "Hell Freezes Over" });
  const studio = song(2, "Hotel California (Remastered)", "Eagles", { collectionName: "Hotel California" });
  const other = song(3, "Take It Easy", "Eagles");
  assert.deepEqual(NTT.normalizeTracks([live, studio, other]).map((t) => t.id), [2, 3]); // studio takes live's place
  assert.deepEqual(NTT.normalizeTracks([studio, live, other]).map((t) => t.id), [2, 3]);
});

test("shuffle is a permutation and does not mutate input", () => {
  const input = [1, 2, 3, 4, 5];
  const out = NTT.shuffle(input, seeded());
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
  assert.deepEqual([...out].sort(), input);
});

test("buildRounds gives distinct-title choices that include the answer", () => {
  const tracks = NTT.normalizeTracks(Array.from({ length: 12 }, (_, i) => song(i, `Song ${i}`, `Artist ${i % 3}`)));
  const rounds = NTT.buildRounds(tracks, 5, seeded(7));
  assert.equal(rounds.length, 5);
  assert.equal(new Set(rounds.map((r) => r.answer.id)).size, 5);
  for (const r of rounds) {
    assert.equal(r.choices.length, NTT.CHOICES_PER_ROUND);
    assert.ok(r.choices.includes(r.answer));
    assert.equal(new Set(r.choices.map((c) => c.title.toLowerCase())).size, r.choices.length);
  }
});

test("buildRounds caps at pool size and rejects tiny pools", () => {
  const four = NTT.normalizeTracks([1, 2, 3, 4].map((i) => song(i, `S${i}`)));
  assert.equal(NTT.buildRounds(four, 10, seeded()).length, 4);
  assert.throws(() => NTT.buildRounds(four.slice(0, 3), 5), /Not enough/);
});

test("pointsForElapsed scores by seconds heard, with boundaries inclusive", () => {
  const cases = [[0, 5], [2, 5], [2.01, 4], [3, 4], [4.9, 3], [5, 3], [9, 2], [9.5, 1], [16, 1], [29.9, 1], [600, 1]];
  for (const [secs, pts] of cases) assert.equal(NTT.pointsForElapsed(secs), pts, `${secs}s`);
  assert.equal(NTT.MAX_POINTS, 5);
});

test("pointsForElapsed treats bad input as no time heard", () => {
  for (const v of [NaN, -3, undefined, Infinity]) assert.equal(NTT.pointsForElapsed(v), 5);
});

// Node's mock clock won't fire timers scheduled during a single tick() call, so step 1 ms at a time.
const advance = (t, ms) => { for (let i = 0; i < ms; i += 1) t.mock.timers.tick(1); };

test("startCountdown ticks 5..1 a second apart, then fires onDone at 5s", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ticks = []; let done = 0;
  NTT.startCountdown(5, { onTick: (n) => ticks.push(n), onDone: () => done++ });
  assert.deepEqual(ticks, [5]);
  advance(t, 3000);
  assert.deepEqual(ticks, [5, 4, 3, 2]);
  assert.equal(done, 0);
  advance(t, 1999);
  assert.deepEqual(ticks, [5, 4, 3, 2, 1]);
  assert.equal(done, 0);
  advance(t, 1);
  assert.equal(done, 1);
  advance(t, 10000);
  assert.equal(done, 1); // fires once
});

test("startCountdown cancel stops all further callbacks", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ticks = []; let done = 0;
  const cancel = NTT.startCountdown(5, { onTick: (n) => ticks.push(n), onDone: () => done++ });
  advance(t, 2000);
  cancel();
  advance(t, 10000);
  assert.deepEqual(ticks, [5, 4, 3]);
  assert.equal(done, 0);
});

test("startCountdown(0) finishes immediately without ticking", () => {
  const ticks = []; let done = 0;
  NTT.startCountdown(0, { onTick: (n) => ticks.push(n), onDone: () => done++ });
  assert.deepEqual(ticks, []);
  assert.equal(done, 1);
});

test("cleanPlayerName trims, collapses spaces, strips control chars, caps length", () => {
  assert.equal(NTT.cleanPlayerName("  Jon   D \n"), "Jon D");
  assert.equal(NTT.cleanPlayerName("A\u0007B"), "AB");
  assert.equal(NTT.cleanPlayerName("x".repeat(50)).length, NTT.MAX_NAME_LENGTH);
  assert.equal(NTT.cleanPlayerName(null), "");
  assert.equal(NTT.cleanPlayerName("   "), "");
});

test("roundsPerPlayer gives everyone the same count and caps by songs available", () => {
  assert.equal(NTT.roundsPerPlayer(200, 0, 10), 10);  // solo
  assert.equal(NTT.roundsPerPlayer(200, 4, 10), 10);
  assert.equal(NTT.roundsPerPlayer(25, 4, 10), 6);    // 25 songs / 4 players
  assert.throws(() => NTT.roundsPerPlayer(3, 4, 10), /4 players/);
  assert.throws(() => NTT.roundsPerPlayer(0, 0, 10), /No playable songs/);
});

test("standings sorts by score with shared ranks for ties", () => {
  assert.deepEqual(NTT.standings(["Ann", "Bo", "Cy", "Di"], [7, 12, 7, 3]), [
    { rank: 1, name: "Bo", score: 12 },
    { rank: 2, name: "Ann", score: 7 },
    { rank: 2, name: "Cy", score: 7 },
    { rank: 4, name: "Di", score: 3 },
  ]);
});

test("addGameToTally appends without mutating and names solo games", () => {
  const t0 = [];
  const t1 = NTT.addGameToTally(t0, { category: "Disco", players: [], scores: [9] });
  const t2 = NTT.addGameToTally(t1, { category: "70's Rock", players: ["Jon", "Ann"], scores: [12, "7"] });
  assert.equal(t0.length, 0);
  assert.equal(t1.length, 1);
  assert.deepEqual(t1[0], { category: "Disco", players: ["Player"], scores: [9] });
  assert.deepEqual(t2[1].scores, [12, 7]);
});

test("tallyTable lines players up across games, leaves gaps, and totals", () => {
  let t = [];
  t = NTT.addGameToTally(t, { category: "70's Rock", players: ["Jon", "Ann"], scores: [12, 7] });
  t = NTT.addGameToTally(t, { category: "Disco", players: ["ann", "Jon", "Cy"], scores: [10, 3, 8] }); // case-insensitive match
  t = NTT.addGameToTally(t, { category: "80s pop", players: ["Jon", "Ann"], scores: [5, 0] });
  const tbl = NTT.tallyTable(t);
  assert.deepEqual(tbl.columns, ["Jon", "Ann", "Cy"]);
  assert.deepEqual(tbl.rows.map((r) => r.cells), [[12, 7, null], [3, 10, 8], [5, 0, null]]);
  assert.deepEqual(tbl.rows.map((r) => r.category), ["70's Rock", "Disco", "80s pop"]);
  assert.deepEqual(tbl.totals, [20, 17, 8]);
  assert.deepEqual(tbl.leaders, [0]);
});

test("tallyTable handles ties, all-zero and empty tallies", () => {
  const tie = NTT.addGameToTally([], { category: "x", players: ["A", "B"], scores: [4, 4] });
  assert.deepEqual(NTT.tallyTable(tie).leaders, [0, 1]);
  const zero = NTT.addGameToTally([], { category: "x", players: ["A", "B"], scores: [0, 0] });
  assert.deepEqual(NTT.tallyTable(zero).leaders, []);
  assert.deepEqual(NTT.tallyTable([]), { columns: [], rows: [], totals: [], leaders: [] });
});

// ---------- hit lists ----------
const T = (rawTitle, artist, album = "") => ({ title: NTT.cleanTitle(rawTitle), rawTitle, artist, album, previewUrl: "https://a/x.m4a" });

test("titleMatches ignores version tags, punctuation, accents and case, but needs the same title", () => {
  assert.ok(NTT.titleMatches("Hotel California (2013 Remaster)", "Hotel California"));
  assert.ok(NTT.titleMatches("Flashdance...What a Feeling", "Flashdance... What a Feeling"));
  assert.ok(NTT.titleMatches("Don't Stop 'Til You Get Enough", "Dont Stop Til You Get Enough"));
  assert.ok(NTT.titleMatches("Another Brick In the Wall, Pt. 2", "Another Brick in the Wall, Pt. 2"));
  assert.ok(!NTT.titleMatches("Money for Nothing", "Money"));
  assert.ok(!NTT.titleMatches("", "Money"));
});

test("artistMatches tolerates billing differences but not different artists", () => {
  assert.ok(NTT.artistMatches("The Jimi Hendrix Experience", "Jimi Hendrix"));
  assert.ok(NTT.artistMatches("Snoop Doggy Dogg", "Snoop Dogg"));
  assert.ok(NTT.artistMatches("Blue Öyster Cult", "Blue Oyster Cult"));
  assert.ok(NTT.artistMatches("Earth, Wind & Fire", "Earth, Wind and Fire"));
  assert.ok(NTT.artistMatches("Kenny Rogers", "Kenny Rogers & Dolly Parton"));
  assert.ok(NTT.artistMatches("Lady Antebellum", "Lady A"));
  assert.ok(!NTT.artistMatches("The Rock Heroes", "Eagles"));
  assert.ok(!NTT.artistMatches("", "Eagles"));
});

test("isLikelyCover flags karaoke, tribute and sound-alike versions", () => {
  assert.ok(NTT.isLikelyCover(T("Hotel California", "Karaoke Hits Band")));
  assert.ok(NTT.isLikelyCover(T("Hotel California", "Eagles Tribute Band")));
  assert.ok(NTT.isLikelyCover(T("Dream On (In the Style of Aerosmith)", "Ameritz")));
  assert.ok(NTT.isLikelyCover(T("Yesterday", "Rockabye Baby!", "Lullaby Renditions of The Beatles")));
  assert.ok(!NTT.isLikelyCover(T("Cover Me", "Bruce Springsteen", "Born in the U.S.A.")));
});

test("pickHitTrack picks the studio original over covers and live versions", () => {
  const results = [
    T("Hotel California", "The Eagles Tribute Band"),
    T("Hotel California (Live)", "Eagles", "Hell Freezes Over"),
    T("Hotel California (2013 Remaster)", "Eagles", "Hotel California"),
    T("Hotel California", "Gipsy Kings"),
  ];
  assert.equal(NTT.pickHitTrack(results, { title: "Hotel California", artist: "Eagles" }).album, "Hotel California");
  assert.equal(NTT.pickHitTrack(results.slice(0, 2), { title: "Hotel California", artist: "Eagles" }).album, "Hell Freezes Over"); // live beats nothing
  assert.equal(NTT.pickHitTrack([results[0], results[3]], { title: "Hotel California", artist: "Eagles" }), null);
});

test("hitEntries converts list rows and drops bad ones", () => {
  assert.deepEqual(NTT.hitEntries([["Dreams", "Fleetwood Mac"], ["", "x"], "junk", ["Only title"]]), [{ title: "Dreams", artist: "Fleetwood Mac" }]);
});

test("planHitRounds plays unplayed songs first and keeps the rest as spares", () => {
  const list = NTT.hitEntries(Array.from({ length: 10 }, (_, i) => [`Song ${i}`, `Artist ${i}`]));
  const played = new Set(list.slice(0, 7).map((e) => NTT.songKey(e.title, e.artist)));
  const { rounds, spares } = NTT.planHitRounds(list, 5, seeded(3), played);
  assert.equal(rounds.length, 5);
  assert.equal(spares.length, 5);
  const firstThree = new Set(rounds.slice(0, 3).map((r) => r.answer.title));
  assert.deepEqual([...firstThree].sort(), ["Song 7", "Song 8", "Song 9"]); // all fresh songs used before any repeat
  for (const r of rounds) {
    assert.equal(r.choices.length, 4);
    assert.ok(r.choices.includes(r.answer));
    assert.equal(new Set(r.choices.map((c) => c.title)).size, 4);
  }
});

// ---------- greatest-hits albums ----------
test("pickHitAlbums prefers hits compilations and skips karaoke/tribute albums", () => {
  const a = (collectionId, collectionName, artistName = "Various Artists") => ({ wrapperType: "collection", collectionId, collectionName, artistName });
  const ids = NTT.pickHitAlbums([
    a(1, "Rumours", "Fleetwood Mac"),
    a(2, "Karaoke Hits of the 70s"),
    a(3, "70s Rock Anthems"),
    a(4, "The Very Best of Fleetwood Mac", "Fleetwood Mac"),
    a(5, "A Tribute to Classic Rock"),
    { wrapperType: "track", collectionId: 6 },
  ], 3);
  assert.deepEqual(ids, [3, 4, 1]);
});

test("album search and lookup URLs", () => {
  const s = new URL(NTT.buildAlbumSearchUrl("Fleetwood Mac", "cb"));
  assert.equal(s.searchParams.get("term"), "Fleetwood Mac greatest hits");
  assert.equal(s.searchParams.get("entity"), "album");
  const l = new URL(NTT.buildLookupUrl([11, 22, -1, 1.5], "cb"));
  assert.equal(l.pathname, "/lookup");
  assert.equal(l.searchParams.get("id"), "11,22");
  assert.equal(l.searchParams.get("entity"), "song");
  assert.throws(() => NTT.buildLookupUrl([], "cb"), /No albums/);
  const h = new URL(NTT.buildHitSearchUrl({ title: "Dream On (Remastered)", artist: "Aerosmith" }, "cb"));
  assert.equal(h.searchParams.get("term"), "Dream On Aerosmith");
});

test("buildSearchUrl encodes input and validates callback", () => {
  const url = new URL(NTT.buildSearchUrl("  AC/DC & friends ", "cb_1"));
  assert.equal(url.searchParams.get("term"), "AC/DC & friends");
  assert.equal(url.searchParams.get("entity"), "song");
  assert.equal(url.searchParams.get("callback"), "cb_1");
  assert.throws(() => NTT.buildSearchUrl("", "cb"), /search term/);
  assert.throws(() => NTT.buildSearchUrl("x", "alert(1)//"), /callback/);
});

test("every preset button has a usable hit list", () => {
  const HIT_LISTS = require("./hits.js");
  const html = require("fs").readFileSync(require("path").join(__dirname, "index.html"), "utf8");
  const presets = JSON.parse(html.match(/const PRESETS = (\[.*?\]);/)[1]);
  assert.deepEqual(Object.keys(HIT_LISTS).sort(), [...presets].sort());
  for (const [name, rows] of Object.entries(HIT_LISTS)) {
    const entries = NTT.hitEntries(rows);
    assert.equal(entries.length, rows.length, `${name}: malformed row`);
    assert.ok(entries.length >= 30, `${name}: only ${entries.length} songs`);
    const keys = entries.map((e) => NTT.songKey(e.title, e.artist));
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    assert.deepEqual(dupes, [], `${name}: duplicates`);
    assert.ok(new Set(entries.map((e) => e.title.toLowerCase())).size >= NTT.CHOICES_PER_ROUND);
  }
});
