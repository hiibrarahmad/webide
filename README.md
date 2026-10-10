# Web IDE for Arduino & ESP32

An online IDE that runs in the browser: write code, import sketches from any GitHub repo, compile in the cloud, **flash the board straight from the browser**, and talk to it with a serial monitor. Nothing to install on the user's PC.

**Open the IDE:** https://hiibrarahmad.github.io/webide/ (Chrome or Edge on desktop)

The compile server deploys to **Hugging Face Spaces** (free, no credit card) through GitHub Actions. Render (`render.yaml`) also works but asks for a card.

## How it works

```
Browser (GitHub Pages)                         Compile server (Docker, e.g. Render)
┌───────────────────────────────┐   sketch   ┌────────────────────────────────┐
│ Monaco editor, GitHub import  │ ─────────▶ │ Express + arduino-cli          │
│ Web Serial: flash + monitor   │ ◀───────── │ AVR & ESP32 cores preinstalled │
└──────────────┬────────────────┘  firmware  └────────────────────────────────┘
               │ USB (Web Serial)
          Your board
```

- **The IDE itself** is static and hosted on GitHub Pages.
- **Compiling** happens on a small server running `arduino-cli`. GitHub Pages can't run programs, so this part runs elsewhere.
- **Flashing** happens in the visitor's browser over Web Serial. The firmware goes straight from the page to the board on their USB port.

## Features
- Monaco editor (the editor from VS Code), multiple projects and files, folder upload, .zip export. Projects are saved in the browser.
- Import from GitHub: `user/repo`, a repo URL, or a folder link like `…/tree/main/examples/Blink`. An optional token covers private repos.
- Board picker for every installed core, with key options (processor, partition scheme, …)
- **Verify** (Ctrl+R) and **Upload** (Ctrl+U). Compile errors are underlined in the code.
- Browser upload for:
  - ESP32 / S2 / S3 / C3 / C6 via `esptool-js`
  - Uno, Nano, Pro Mini (STK500v1 / Optiboot)
  - Mega 2560 (STK500v2)
  - Other boards: the firmware file is downloaded instead
- Serial monitor with baud rate, line endings, timestamps, and board reset
- Library search and install

## Setup (owner)

1. **Deploy the compile server (free, no card).** Create a [Hugging Face](https://huggingface.co/join) account, then an [access token](https://huggingface.co/settings/tokens) with **Write** permission. Add it to this repo as the Actions secret `HF_TOKEN` and run the *Deploy compile server to Hugging Face Spaces* workflow. The URL is shown in the run summary, e.g. `https://hiibrarahmad-webide.hf.space`. The first build takes 15–25 minutes.
2. **Point the IDE at it.** In this repo go to *Settings → Secrets and variables → Actions → Variables* and add `COMPILE_SERVER_URL` = that URL. Then re-run the *Deploy IDE to GitHub Pages* workflow.
3. Open https://hiibrarahmad.github.io/webide/. The status bar should say **Compile server: online**.

Anyone can also point the IDE at their own compile server by clicking the status-bar indicator.

> Free Spaces sleep after 48 hours without use; the first request after that waits while it starts up.

The server also serves the full IDE, so the Space URL works as the IDE on its own.

## Server settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call the API (CORS) |
| `COMPILE_JOBS` | `0` (all CPUs) | Parallel compiler jobs per build |
| `MAX_CONCURRENT_COMPILES` | `2` | Builds running at once; the rest queue |
| `ALLOW_LIB_INSTALL` | `true` | Allow installing libraries from the Library panel |

Docker build arg `CORES` chooses which cores go into the image (default `arduino:avr esp32:esp32`).

## Run locally

Requires Node 18+ and [arduino-cli](https://arduino.github.io/arduino-cli/) with your cores installed.

```
npm install
npm start            # http://localhost:3000
```

## Project layout
- `server.js`: compile API (`/api/compile`, `/api/boards`, `/api/board`, `/api/libs/*`, `/api/health`)
- `public/js/app.js`: UI, editor, serial monitor, upload flow
- `public/js/avr.js`: Intel HEX parser and STK500 v1/v2 flasher over Web Serial
- `public/js/github.js`: GitHub importer
- `scripts/build-static.mjs`: builds the GitHub Pages site into `dist/`
- `Dockerfile`, `.github/workflows/hf-space.yml`: compile server deployment (`render.yaml` for Render)

## Troubleshooting uploads
- **"Failed to open serial port"**: Windows refused to open the port.
  - Pick the right port with 🔌 (not COM1 or a Bluetooth port).
  - Close other programs or tabs using it.
  - For CH340 clone boards, recent WCH drivers (3.8+ / 4.x) reject many clone chips. Install the older CH340 driver 3.4/3.5, or choose it under Device Manager → Update driver → *Let me pick*.
- **"Could not sync with bootloader"**: wrong board, or a Nano with the old bootloader. Choose *Processor: ATmega328P (Old Bootloader)*.

## Security
The compile server runs `arduino-cli` on code from anyone who can reach it. It runs as a non-root user in a container, with per-IP rate limits, a compile queue, and a filter on dangerous `build_opt.h` flags. Don't put secrets in the container. Set `ALLOWED_ORIGINS` to your Pages URL.
