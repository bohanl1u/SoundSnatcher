# SoundSnatcher

Paste a YouTube link, get the audio as MP3 or WAV. One input, one **Snatch** button,
one **Another One** button to reset. Optionally tag the download filename with the
track's BPM and musical key.

## Requirements

- Node 20+
- [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) and [`ffmpeg`](https://ffmpeg.org) on your `PATH`

```bash
brew install node yt-dlp ffmpeg
```

## Run

```bash
npm install && npm start
```

Then open <http://localhost:4747>. `npm run doctor` verifies the external binaries are
found; `PORT=8080 npm start` changes the port.

## How it works

Snatching downloads the best audio-only stream **once** into a per-job working directory.
Format conversion happens on download, so switching between 320 kbps and WAV doesn't
re-fetch anything. **Another One** deletes the job's files immediately; anything left
behind by a closed tab is swept after two hours.

| Format | Detail |
| --- | --- |
| MP3 | 128 / 192 / 256 / 320 kbps, LAME, 44.1 kHz |
| WAV | 16-bit PCM, 44.1 kHz |

### Filenames

With **Analyze key & BPM** ticked, the measurements go straight into the filename, which
is the point — a DJ library sorts on it:

```
Artist - Track Name - 128BPM - Fmin.mp3
```

Unticked, you just get `Artist - Track Name.mp3`. The UI previews the exact filename
before you download, and also shows the [Camelot](https://mixedinkey.com/harmonic-mixing-guide/)
code for harmonic mixing.

## Analysis accuracy

Both measurements are computed from the decoded audio in plain JavaScript — no native
addons, no external analysis service.

**Tempo** — spectral-flux onset envelope, autocorrelation, then comb-filter scoring across
a fine BPM grid weighted by a log-normal prior. The prior is what resolves half- and
double-time: a pulse train at half speed lands on every other beat and scores nearly
identically on the autocorrelation alone.

**Key** — chroma built from interpolated spectral peaks (summing every FFT bin lets
broadband percussion vote for all twelve pitch classes at once), correlated against
[Sha'ath's key profiles](https://www.ibrahimshaath.co.uk/keyfinder/), which are fitted to
electronic and popular music.

Measured against 17 reference tracks whose BPM and key are stated by their producers:

| | Result |
| --- | --- |
| BPM | 14/17 exact, 3 octave-off (half/double time), 0 otherwise wrong |
| Key | 8/14 exact, 1 fifth-error, 5 wrong |

Read those numbers honestly. **Tempo is reliable; key is a hint, not a verdict.** Key
detection from a mixed-down master is genuinely hard: relative major/minor pairs share six
of seven notes, and a loop with no third in it has no mode to detect. The confidence
figures the analyser reports are low precisely when the material is ambiguous. If the key
matters, check it by ear.

Half/double-time readings are usually a genre convention rather than an error — drill is
written at 140 and felt at 70, and both are defensible answers.

`npm test` runs the analyser against synthetic audio with known ground truth — click
tracks at fixed tempos, chord progressions in known keys, and a mix of both.

## Exposing it publicly

By default nothing is restricted — it's your machine. Set `PUBLIC_MODE=true` and a set of
guardrails switch on for a shared instance:

```bash
PUBLIC_MODE=true \
ALLOWED_ORIGINS="https://bohanl1u.github.io" \
TRUST_PROXY=true \
npm start
```

| Variable | Default | What it does |
| --- | --- | --- |
| `PUBLIC_MODE` | `false` | Master switch. Everything below is inert without it |
| `RATE_LIMIT_SNATCH_PER_MIN` | `3` | Downloads per IP per minute |
| `RATE_LIMIT_POLL_PER_MIN` | `120` | Job status polls per IP per minute |
| `RATE_LIMIT_DOWNLOAD_PER_MIN` | `10` | File downloads per IP per minute |
| `MAX_CONCURRENT_JOBS` | `2` | Jobs running at once, across everyone |
| `MAX_DURATION_SECONDS` | `1200` | Videos longer than this are refused before downloading |
| `MAX_FILESIZE` | `100M` | Passed to `yt-dlp --max-filesize` |
| `ALLOWED_ORIGINS` | none | Comma-separated origins allowed to call the API from a browser |
| `TRUST_PROXY` | `false` | Read `CF-Connecting-IP` / `X-Forwarded-For`. Only enable behind a real proxy |

Rate limiting is worth being precise about: it does **not** defeat YouTube's bot detection.
A residential IP and valid cookies are what make requests succeed. What the limits do is
keep request volume low enough that the IP isn't flagged in the first place, and stop one
visitor from spending all of your bandwidth.

`TRUST_PROXY` matters. Forwarded-IP headers are ignored unless you set it, because
otherwise anyone could spoof a header and reset their own rate limit on every request.

The long videos are rejected by `yt-dlp --match-filter` *before* any bytes transfer, so an
over-length link costs nothing.

## Landing page

`docs/` holds a static site for GitHub Pages. It probes `/api/health` on load and reveals a
live demo section only when an instance actually answers — so when the machine hosting it is
asleep, visitors get a complete page rather than a broken embed. It also detects a copy
already running on the visitor's own machine and points them at that instead.

Set `DEMO_ORIGIN` at the top of `docs/app.js` to your public tunnel hostname to enable the
remote demo. Leave it empty and only local detection runs.

## Notes

This runs on your machine and talks only to YouTube. Don't expose the port to a network you
don't control without `PUBLIC_MODE=true`.

Only rip audio you have the rights to use.
