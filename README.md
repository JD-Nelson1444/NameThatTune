# Name That Tune

A browser music-quiz game. Hear a song preview, pick its title from four choices — the faster you answer, the more points you score.

- Up to 8 players take turns, with a live scoreboard, final standings and a running scoreboard for the session
- Preset categories, or search any artist, genre or decade (saved as new categories)
- Timed scoring: answer within 2s = 5 pts, 3s = 4, 5s = 3, 9s = 2, later = 1, wrong = 0
- Intro/outro music, looping background video, and an in-game **How to play** screen

Song previews and artwork come from the [iTunes Search API](https://performance-partners.apple.com/search-api), courtesy of Apple Music.

## Files

| File | What it is |
|---|---|
| `index.html` | The game page (loads `logic.js` and `hits.js`) |
| `logic.js` | Game logic with no DOM or network code: scoring, rounds, players, standings |
| `hits.js` | Curated hit-song lists for the preset categories |
| `name-that-tune.html` | Single-file copy of the game, with `index.html`, `logic.js` and `hits.js` inlined |
| `videos/` | Background videos, one picked at random per visit |
| `logic.test.js` | Unit tests for `logic.js` |

`name-that-tune.html` is maintained by hand. When you change `index.html`, `logic.js` or `hits.js`, make the same change there.

## Running it

Open `index.html` in a browser. Serving the folder works best, for example with VS Code's Live Server, or:

```bash
python -m http.server 8000
```

then visit http://localhost:8000. It needs an internet connection, because songs stream from Apple Music.

Sound won't play in VS Code's built-in phone-preview extensions, because they can't decode Apple's AAC audio. To test on a phone screen with sound, use Chrome or Edge device mode (F12, then Ctrl+Shift+M) or a real phone.

## Tests

```bash
node --test
```
