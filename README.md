# Web IDE for Arduino & ESP32

An online IDE that runs in the browser: write code, import sketches from any GitHub repo, compile in the cloud, **flash the board straight from the browser**, and talk to it with a serial monitor. Nothing to install on the user's PC.

**Open the IDE:** https://hiibrarahmad.github.io/webide/ (Chrome or Edge on desktop)

Compiling is free: it runs on **GitHub Actions** in this repo, so no server, hosting account or credit card is needed. A self-hosted compile server is optional and faster.

## How it works

```
Browser (GitHub Pages)                       GitHub Actions (free)
┌──────────────────────────────┐  dispatch  ┌───────────────────────────────┐
│ Monaco editor, GitHub import │ ─────────▶ │ arduino-cli + cached cores    │
│ Web Serial: flash + monitor  │ ◀───────── │ result.json on ide-build/<id> │
└──────────────┬───────────────┘  firmware  └───────────────────────────────┘
               │ USB (Web Serial)
          Your board
```

- **The IDE itself** is static and hosted on GitHub Pages.
- **Compiling** runs the *Compile sketch* workflow in your repo. The IDE starts it through the GitHub API with your token, then downloads the firmware. AVR builds take about 15–35 s and ESP32 builds about 1–2 min. Libraries listed in a `libraries.txt` file in the sketch are installed during the build.
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
- Libraries: list them in `libraries.txt` (GitHub Actions builds), or search and install with a compile server

## Setup

1. Open https://hiibrarahmad.github.io/webide/ and click **Compiling not set up** in the bottom status bar.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories → webide**.
   - Permissions: **Actions** and **Contents**, both *Read and write*.
3. Paste the token in the dialog and click **Save**. The token stays in your browser only.

**Other people:** [fork this repo](https://github.com/hiibrarahmad/webide/fork), enable Actions in the fork, then use your fork's name and a token for it in the same dialog. Every user's builds run on their own GitHub account.

### Optional: compile server (seconds instead of a minute)
Run `npm start` locally (needs arduino-cli) or the Docker image anywhere, then enter its URL in the same dialog. When a server is reachable, the IDE uses it instead of GitHub Actions and also offers library search.

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
- `.github/workflows/compile.yml`, `scripts/ci-compile.mjs`, `compile.js`: free GitHub Actions compile backend
- `Dockerfile`: self-hosted compile server (`render.yaml` and `hf-space.yml` deploy it to Render or Hugging Face PRO)

## Troubleshooting uploads
- **"Failed to open serial port"**: Windows refused to open the port.
  - Pick the right port with 🔌 (not COM1 or a Bluetooth port).
  - Close other programs or tabs using it.
  - For CH340 clone boards, recent WCH drivers (3.8+ / 4.x) reject many clone chips. Install the older CH340 driver 3.4/3.5, or choose it under Device Manager → Update driver → *Let me pick*.
- **"Could not sync with bootloader"**: wrong board, or a Nano with the old bootloader. Choose *Processor: ATmega328P (Old Bootloader)*.

## Security
The compile server runs `arduino-cli` on code from anyone who can reach it. It runs as a non-root user in a container, with per-IP rate limits, a compile queue, and a filter on dangerous `build_opt.h` flags. Don't put secrets in the container. Set `ALLOWED_ORIGINS` to your Pages URL.
