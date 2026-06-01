# 🎧 Spotify Playlist Pipeline

Fetch a Spotify playlist → analyse audio features + confidence → sort harmonically using a TSP algorithm → export CSV → create a new sorted playlist in your Spotify account.

---

## Features

- **Fetches** all tracks from any Spotify playlist (public or private)
- **Audio Features** — BPM, key, energy, danceability, valence, loudness, etc.
- **Audio Analysis** — key confidence, tempo confidence, fade in/out points
- **Camelot wheel** mapping with reliability flags (`✓` / `⚠ check`)
- **TSP sort algorithm** — finds the optimal track order minimising harmonic clashes and BPM jumps simultaneously
- **3 sort modes** tailored to different listening contexts
- **Exports a CSV** with all data + confidence scores
- **Creates the sorted playlist** directly in your Spotify account
- **Warns** about tracks with low key/BPM confidence in the terminal

---

## Sort Modes

| Mode | Harmony weight | BPM weight | Best for |
|---|---|---|---|
| `dj` | 70% | 30% | DJ sets, dance playlists |
| `listen` | 50% | 50% | Active listening, balanced flow |
| `adrenaline` | 30% | 70% | Workout, energy build |

The TSP (Travelling Salesman Problem) algorithm penalises:
- Camelot key distance (incompatible keys cost more)
- BPM jumps (backwards BPM motion costs 1.5× more than forward)

---

## Requirements

- [Node.js](https://nodejs.org/) v18+
- A [Spotify Developer App](https://developer.spotify.com/dashboard)

---

## Setup

### 1. Create a Spotify Developer App

1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Click **Create App**
3. Fill in name and description
4. Set **Redirect URI** to exactly: `http://localhost:8888/callback`
5. Check **Web API**
6. Copy your **Client ID** and **Client Secret**

### 2. Install dependencies

```bash
npm install
```

### 3. Configure `pipeline.js`

Open `pipeline.js` and edit the config section at the top:

```js
const CLIENT_ID       = "your_client_id";
const CLIENT_SECRET   = "your_client_secret";
const SOURCE_PLAYLIST = "https://open.spotify.com/playlist/YOUR_PLAYLIST_ID";
const SORT_MODE       = "listen"; // "dj" | "listen" | "adrenaline"
const NEW_PLAYLIST_NAME   = "";   // leave empty to auto-name
const NEW_PLAYLIST_PUBLIC = false;
```

### 4. Run

```bash
npm start
```

The script will:
1. Open Spotify login in your browser
2. Fetch all tracks from the source playlist
3. Fetch audio features (BPM, key, energy, etc.)
4. Fetch audio analysis for each track (key/tempo confidence, fade points)
5. Sort using the TSP algorithm
6. Warn about unreliable key/BPM detections
7. Save a sorted `.csv` file locally
8. Create the sorted playlist in your Spotify account

---

## CSV Output

The exported CSV contains:

| Column | Description |
|---|---|
| `#` | Position in sorted playlist |
| `Song` / `Artist` | Track info |
| `BPM` | Tempo |
| `BPM OK` | ✓ reliable / ⚠ check |
| `BPM Conf` | Tempo confidence % |
| `Camelot` | Camelot wheel key (e.g. `7A`) |
| `Camelot OK` | ✓ reliable / ⚠ check |
| `Key Conf` | Key confidence % |
| `Mode Conf` | Major/minor confidence % |
| `Key` | Standard key name (e.g. `Dm`) |
| `Fade In` | Time before track fully starts |
| `Fade Out` | Time where fade out begins |
| `Energy` | 0–100 |
| `Dance` | Danceability 0–100 |
| `Valence` | Positivity 0–100 |
| `Acoustic` | Acousticness 0–100 |
| `Instrumental` | Instrumentalness 0–100 |
| `Loud (Db)` | Loudness in dB |
| `Popularity` | Spotify popularity score |
| `Spotify Track Id` | Track ID for reimport |
| `ISRC` | International Standard Recording Code |

---

## Camelot Wheel Reference

```
 1A G#m  ↔  1B B
 2A Ebm  ↔  2B F#
 3A Bbm  ↔  3B Db
 4A Fm   ↔  4B Ab
 5A Cm   ↔  5B Eb
 6A Gm   ↔  6B Bb
 7A Dm   ↔  7B F
 8A Am   ↔  8B C
 9A Em   ↔  9B G
10A Bm   ↔ 10B D
11A F#m  ↔ 11B A
12A C#m  ↔ 12B E
```

**Compatible transitions:** same number (A↔B), adjacent numbers (±1) same letter, or same key.

---

## Low Confidence Warnings

After sorting, the terminal prints tracks where Spotify's key or tempo detection scored below 50%:

```
⚠️  2 track(s) with low confidence — verify manually:
  #12 Some Song — Camelot 7A (key:42% mode:38%)
  #34 Other Song — BPM 128 (conf:31%)
```

For these tracks, manually verify the key/BPM using [Tunebat](https://tunebat.com) or [Mixed In Key](https://mixedinkey.com).

---

## License

MIT
