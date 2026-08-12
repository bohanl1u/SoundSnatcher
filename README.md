# SoundSnatcher — website

The landing page for SoundSnatcher, served at
**<https://bohanl1u.github.io/SoundSnatcher/>** by GitHub Pages from `docs/`.

## 👉 Looking for the tool itself?

The thing you download and run lives in a separate repository:

### **[github.com/bohanl1u/soundsnatcher-app](https://github.com/bohanl1u/soundsnatcher-app)**

```bash
brew install node yt-dlp ffmpeg
git clone https://github.com/bohanl1u/soundsnatcher-app.git
cd soundsnatcher-app
npm install && npm start
```

This repository holds only the website. Nothing here is needed to run SoundSnatcher.

## What's in here

| Path | Purpose |
| --- | --- |
| `docs/index.html` | The landing page |
| `docs/legal.html` | Terms, privacy and disclaimers |
| `docs/demo.json` | Address of the live demo, or empty when it's offline |
| `docs/llms.txt` | Machine-readable summary for AI crawlers |
| `docs/robots.txt`, `docs/sitemap.xml` | Indexing |
| `scripts/serve-public.sh` | Puts the live demo online |

## The live demo

The page is static and always up. The demo section is hidden by default and only
appears if a running instance answers its health check — so when the machine hosting it is
asleep, visitors get a complete page rather than a broken embed. A copy already running on
the visitor's own machine is detected too, and preferred over the shared demo.

To put the demo online, from this repository:

```bash
./scripts/serve-public.sh
```

That opens a Cloudflare quick tunnel, runs the app with the public guardrails on, writes the
tunnel address into `docs/demo.json`, and pushes. Ctrl-C takes it offline again and pushes
the empty state back.

It expects the tool checked out alongside this repository:

```
~/Documents/
├── soundsnatcher/       ← this repo (website)
└── soundsnatcher-app/   ← the tool
```

Point `APP_DIR` somewhere else if your layout differs.

A quick tunnel gets a fresh hostname on every run, which is why the address lives in
`docs/demo.json` rather than in the page's JavaScript — only that one file changes. For a
stable hostname you'd want a named Cloudflare tunnel with your own domain, or Tailscale
Funnel.
