/* Pure game logic: no DOM, no network. Works as a browser global (NTT) and a CommonJS module (tests). */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NTT = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /**
   * Scoring cut-offs in seconds of music heard: guess within 2s = 5 pts, 3s = 4, 5s = 3, 9s = 2,
   * anything later (including after the preview ends) = 1. A wrong guess scores 0.
   */
  const SCORE_STEPS = [2, 3, 5, 9, 16];
  const MAX_POINTS = SCORE_STEPS.length;
  const CLIP_SECONDS = 30; // iTunes previews are ~30s
  const MAX_PLAYERS = 8;
  const MAX_NAME_LENGTH = 20;
  const CHOICES_PER_ROUND = 4;

  /** Strip version noise so "Song (Remastered 2011)" and "Song - Live" compare equal. */
  function cleanTitle(title) {
    return String(title || "")
      .replace(/\s*[([].*?[)\]]\s*/g, " ")
      .replace(/\s+-\s+.*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function keyOf(title, artist) {
    return (cleanTitle(title) + "|" + String(artist || "")).toLowerCase().replace(/[^a-z0-9|]/g, "");
  }

  /** iTunes Search API results -> playable, de-duplicated tracks. */
  function normalizeTracks(results) {
    const seen = new Map(); // key -> index in out
    const out = [];
    for (const r of results || []) {
      if (!r || r.kind !== "song" || !r.previewUrl || !r.trackName) continue;
      if (!/^https:\/\//.test(r.previewUrl)) continue; // never load non-HTTPS media
      const key = keyOf(r.trackName, r.artistName);
      const isAlt = ALT_VERSION_RE.test(`${r.trackName} ${r.collectionName || ""}`);
      if (seen.has(key)) {
        // Same song twice (e.g. live and studio): keep the studio original whichever came first.
        const prev = out[seen.get(key)];
        if (isAlt || !ALT_VERSION_RE.test(`${prev.rawTitle} ${prev.album}`)) continue;
      }
      const at = seen.has(key) ? seen.get(key) : out.length; // replace in place, or append
      seen.set(key, at);
      out[at] = ({
        id: r.trackId,
        title: cleanTitle(r.trackName) || r.trackName,
        rawTitle: r.trackName,
        artist: r.artistName || "Unknown artist",
        album: r.collectionName || "",
        year: r.releaseDate ? String(r.releaseDate).slice(0, 4) : "",
        previewUrl: r.previewUrl,
        artworkUrl: (r.artworkUrl100 || "").replace("100x100bb", "400x400bb"),
        trackViewUrl: r.trackViewUrl || "",
      });
    }
    return out;
  }

  /** Fisher–Yates; injectable RNG for deterministic tests. Returns a new array. */
  function shuffle(arr, rng = Math.random) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /**
   * Pick `count` answer tracks, each with CHOICES_PER_ROUND options whose titles are distinct.
   * Throws if the pool cannot supply enough distinct titles.
   */
  function buildRounds(tracks, count, rng = Math.random) {
    assertEnoughTitles(tracks);
    const answers = shuffle(tracks, rng).slice(0, Math.min(count, tracks.length));
    return answers.map((answer) => makeRound(answer, tracks, rng));
  }

  function assertEnoughTitles(pool) {
    const titles = new Set(pool.map((t) => t.title.toLowerCase()));
    if (titles.size < CHOICES_PER_ROUND) throw new Error("Not enough different songs for this search. Try a broader term.");
  }

  /** One round: the answer plus CHOICES_PER_ROUND - 1 wrong options from `pool`, all with different titles. */
  function makeRound(answer, pool, rng = Math.random) {
    const used = new Set([answer.title.toLowerCase()]);
    const distractors = [];
    for (const t of shuffle(pool, rng)) {
      if (distractors.length === CHOICES_PER_ROUND - 1) break;
      const k = t.title.toLowerCase();
      if (used.has(k)) continue;
      used.add(k);
      distractors.push(t);
    }
    return { answer, choices: shuffle([answer, ...distractors], rng) };
  }

  // ---------- Hit lists (preset categories) ----------

  /** Comparable form of a title or artist: no accents, "&" = "and", no punctuation, no leading "the". */
  function norm(s) {
    return String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
      .replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().replace(/^the /, "");
  }

  /** Same song title, ignoring version tags like "(Remastered 2011)" or " - Live". Exact match only. */
  function titleMatches(resultTitle, wanted) {
    const a = norm(cleanTitle(resultTitle)), b = norm(cleanTitle(wanted));
    return a !== "" && a === b;
  }

  /**
   * Same artist, tolerating billing differences: "The Jimi Hendrix Experience" for "Jimi Hendrix",
   * "Snoop Doggy Dogg" for "Snoop Dogg", "Kenny Rogers & Dolly Parton" for "Kenny Rogers".
   */
  function artistMatches(resultArtist, wanted) {
    const a = norm(resultArtist), b = norm(wanted);
    if (!a || !b) return false;
    if (a.includes(b) || b.includes(a)) return true;
    const lead = norm(String(wanted).split(/\s*(?:&|,|\band\b|\bfeat\.?|\bfeaturing\b|\bwith\b)\s*/i)[0]);
    return lead.length >= 4 && a.includes(lead);
  }

  // Sound-alike, karaoke and novelty re-recordings that flood iTunes "hits" searches.
  const COVER_RE = /karaoke|tribute|in the style of|made famous|originally performed|as performed by|cover version|lullab|rockabye|kidz bop|sound[- ]?alike|hit crew|starlite singers|backing track|8[- ]?bit|string quartet|piano version|instrumental version/i;
  const ALT_VERSION_RE = /\b(live|remix|demo|acoustic|unplugged|re-?recorded|rehearsal)\b/i;

  function isLikelyCover(track) {
    return COVER_RE.test(`${track.artist || ""} | ${track.album || ""} | ${track.rawTitle || track.title || ""}`);
  }

  /** The best playable result for a hit-list entry: right title, right artist, not a cover; studio version first. */
  function pickHitTrack(tracks, entry) {
    const ok = tracks.filter((t) => titleMatches(t.rawTitle || t.title, entry.title)
      && artistMatches(t.artist, entry.artist) && !isLikelyCover(t));
    return ok.find((t) => !ALT_VERSION_RE.test(`${t.rawTitle || ""} ${t.album || ""}`)) || ok[0] || null;
  }

  function songKey(title, artist) { return norm(cleanTitle(title)) + "|" + norm(artist); }

  /** [[title, artist], ...] -> [{ title, artist }]; drops malformed rows. */
  function hitEntries(list) {
    return (list || []).filter((e) => Array.isArray(e) && e[0] && e[1]).map(([title, artist]) => ({ title, artist }));
  }

  /**
   * Choose answers for a game from a hit list: songs not yet played this session first (random order),
   * then repeats. Wrong options come from the whole list. Unused entries are returned as `spares`
   * to stand in when a song can't be found on iTunes.
   */
  function planHitRounds(entries, count, rng = Math.random, playedKeys = new Set()) {
    assertEnoughTitles(entries);
    const fresh = entries.filter((e) => !playedKeys.has(songKey(e.title, e.artist)));
    const stale = entries.filter((e) => playedKeys.has(songKey(e.title, e.artist)));
    const order = [...shuffle(fresh, rng), ...shuffle(stale, rng)];
    const answers = order.slice(0, Math.min(count, order.length));
    return { rounds: answers.map((a) => makeRound(a, entries, rng)), spares: order.slice(answers.length) };
  }

  // ---------- Greatest-hits albums (typed categories) ----------

  const HIT_ALBUM_RE = /\bhits\b|greatest|best of|\bessential|anthems|classics|number ones|#1s|\bgold\b|the very best|collection/i;

  /** Album search results -> up to `max` collection ids, greatest-hits style albums first, covers skipped. */
  function pickHitAlbums(results, max = 5) {
    const albums = (results || []).filter((r) => r && r.wrapperType === "collection" && Number.isInteger(r.collectionId)
      && !COVER_RE.test(`${r.collectionName || ""} | ${r.artistName || ""}`));
    const hitish = albums.filter((r) => HIT_ALBUM_RE.test(r.collectionName || ""));
    const rest = albums.filter((r) => !hitish.includes(r));
    return [...hitish, ...rest].slice(0, max).map((r) => r.collectionId);
  }

  function pointsForElapsed(seconds) {
    const t = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const idx = SCORE_STEPS.findIndex((limit) => t <= limit);
    return idx === -1 ? 1 : MAX_POINTS - idx;
  }

  function checkCallback(name) {
    if (!/^[A-Za-z_$][\w$.]*$/.test(name)) throw new Error("Invalid callback name.");
  }

  function buildSearchUrl(term, callbackName, { limit = 200, country = "US", entity = "song" } = {}) {
    const q = String(term || "").trim();
    if (!q || q.length > 140) throw new Error("Enter a search term of 1–100 characters.");
    checkCallback(callbackName);
    const p = new URLSearchParams({ term: q, media: "music", entity, limit: String(limit), country, callback: callbackName });
    return "https://itunes.apple.com/search?" + p.toString();
  }

  /** Search for one specific hit ("Hotel California Eagles"). */
  function buildHitSearchUrl(entry, callbackName) {
    return buildSearchUrl(`${cleanTitle(entry.title)} ${entry.artist}`, callbackName, { limit: 15 });
  }

  /** Search for greatest-hits style albums for a typed category. */
  function buildAlbumSearchUrl(term, callbackName) {
    return buildSearchUrl(`${String(term || "").trim()} greatest hits`, callbackName, { limit: 50, entity: "album" });
  }

  /** Songs on several albums in one request. */
  function buildLookupUrl(ids, callbackName) {
    const list = (ids || []).filter((id) => Number.isInteger(id) && id > 0);
    if (!list.length) throw new Error("No albums to look up.");
    checkCallback(callbackName);
    const p = new URLSearchParams({ id: list.join(","), entity: "song", limit: "200", country: "US", callback: callbackName });
    return "https://itunes.apple.com/lookup?" + p.toString();
  }

  const COUNTDOWN_SECONDS = 5;

  /** Trim, collapse whitespace, drop control characters, cap length. Returns "" for unusable input. */
  function cleanPlayerName(name) {
    return String(name ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH).trim();
  }

  /**
   * Rounds each player gets: the number they asked for, reduced so every player gets the same count
   * from the songs available. Throws if there isn't at least one song per player.
   */
  function roundsPerPlayer(trackCount, playerCount, requested) {
    const n = Math.max(1, playerCount | 0);
    const per = Math.min(Math.max(1, requested | 0), Math.floor(trackCount / n));
    if (per < 1) throw new Error(n > 1 ? `Not enough songs for ${n} players. Try a broader search.` : "No playable songs found. Try a broader search.");
    return per;
  }

  /** Highest score first; ties share a rank (1, 1, 3) and keep turn order. */
  function standings(players, scores) {
    const rows = players.map((name, i) => ({ name, score: scores[i] || 0, order: i }))
      .sort((a, b) => b.score - a.score || a.order - b.order);
    let rank = 0;
    return rows.map((r, i) => {
      if (i === 0 || r.score !== rows[i - 1].score) rank = i + 1;
      return { rank, name: r.name, score: r.score };
    });
  }

  /**
   * Ticks onTick(n) for n = seconds..1, one second apart, then calls onDone().
   * Returns cancel(); after cancel neither callback fires. Timer fns are injectable for tests.
   */
  function startCountdown(seconds, { onTick, onDone, setTimer = setTimeout, clearTimer = clearTimeout }) {
    let remaining = Math.max(0, Math.floor(seconds));
    let handle = null;
    let cancelled = false;
    const step = () => {
      if (cancelled) return;
      if (remaining === 0) return onDone();
      onTick(remaining--);
      handle = setTimer(step, 1000);
    };
    step();
    return () => { cancelled = true; if (handle !== null) clearTimer(handle); };
  }

  const SOLO_NAME = "Player";

  /**
   * Session scoreboard. A tally is a plain array of finished games: [{ category, players: [name], scores: [n] }].
   * Returns a new array (never mutates). An unnamed solo game is recorded under SOLO_NAME.
   */
  function addGameToTally(tally, { category, players, scores }) {
    const names = players && players.length ? players.map(cleanPlayerName) : [SOLO_NAME];
    const game = { category: String(category || ""), players: names, scores: names.map((_, i) => Number(scores[i]) || 0) };
    return [...(Array.isArray(tally) ? tally : []), game];
  }

  /**
   * Table view of a tally. Columns are everyone who has played, in order of first appearance, matched by name
   * ignoring case. A cell is null when that person sat a game out. leaders = column indexes with the top total.
   */
  function tallyTable(tally) {
    const columns = [];
    const index = new Map();
    for (const g of tally) for (const name of g.players) {
      const key = name.toLowerCase();
      if (!index.has(key)) { index.set(key, columns.length); columns.push(name); }
    }
    const rows = tally.map((g, n) => {
      const cells = columns.map(() => null);
      g.players.forEach((name, i) => { cells[index.get(name.toLowerCase())] = g.scores[i]; });
      return { game: n + 1, category: g.category, cells };
    });
    const totals = columns.map((_, c) => rows.reduce((sum, r) => sum + (r.cells[c] || 0), 0));
    const best = Math.max(0, ...totals);
    const leaders = best > 0 ? totals.flatMap((t, c) => (t === best ? [c] : [])) : [];
    return { columns, rows, totals, leaders };
  }

  return { norm, titleMatches, artistMatches, isLikelyCover, pickHitTrack, songKey, hitEntries, planHitRounds, makeRound,
    pickHitAlbums, buildHitSearchUrl, buildAlbumSearchUrl, buildLookupUrl, addGameToTally, tallyTable, SOLO_NAME, SCORE_STEPS, MAX_POINTS, CLIP_SECONDS, MAX_PLAYERS, MAX_NAME_LENGTH, cleanPlayerName, roundsPerPlayer, standings, CHOICES_PER_ROUND, COUNTDOWN_SECONDS, startCountdown, cleanTitle, normalizeTracks, shuffle, buildRounds, pointsForElapsed, pointsForTime: pointsForElapsed, buildSearchUrl };
});
