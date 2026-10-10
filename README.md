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

**Editor and projects**
- Monaco editor (the editor from VS Code) with a modern dark/light workbench: icon bar, resizable side and bottom panels, tabs, status bar
- Multiple projects, files and folders (saved in your browser), file/folder upload, .zip export
- Examples: Blink, Debugger, Serial Plotter, Serial Echo, Analog plot, Button, Wi-Fi scan, ESP32 crash decoder
- Import any sketch from GitHub: `user/repo`, a repo URL, or a folder link like `…/tree/main/examples/Blink`

**Build and upload**
- **Verify** (Ctrl+R) and **Upload** (Ctrl+U), with flash and RAM usage bars after every build
- **Problems** panel: compiler errors and warnings, underlined in the code; click one to jump to it
- Upload from the browser over Web Serial:
  - ESP32, S2, S3, C3, C6, H2 and ESP8266 via `esptool-js`
  - Uno, Nano, Pro Mini (STK500v1) and Mega 2560 (STK500v2), with page-by-page verify and automatic retry
  - RP2040 / Pico: the UF2 file is written straight to the board's USB drive
  - Other boards: the firmware file is downloaded

**Serial tools**
- **Serial Monitor**: text or hex view, filter, timestamps, DTR/RTS control, send history (↑/↓), save log, line endings
- **Serial Plotter**: prints like `temp:21.5 hum:40` or `1 2 3` become live graphs; click a legend entry to hide a series

**Debugging** (see below)
- Serial debugger: live **watches**, **breakpoints** with Continue/Run, asserts, traces and logs, and the paused line highlighted in the editor
- **ESP32 crash decoder**: "Guru Meditation" backtraces are turned into function names and sketch lines
- Board tools: chip info, reset, ESP flash erase, ESP32 core debug level

**Boards and libraries**
- Built-in board list (Arduino AVR, ESP32 family, ESP8266, RP2040, Uno R4, Nano Every) plus **Add board** for any core
- Library search over all 10,000+ Arduino libraries; GitHub URLs and .zip links work too

## Debugging

1. Open the **Debugger** example, or click **Add WebIDEDebug.h to sketch** in the Debug view.
2. Turn on **Debug build** (the bug button in the toolbar).
3. Upload. The Serial Monitor opens and the **Debug** tab shows what the board reports.

| In your code | What you see |
|---|---|
| `DBG_WATCH(x)` | `x` in the Watch table (current and previous value), and in the Plotter if it is a number |
| `DBG_BREAK()` / `DBG_BREAK_IF(cond)` | The board pauses, the line is highlighted, and you press **Continue** (or **Run** to skip further breakpoints) |
| `DBG_ASSERT(cond)` | Reports the failed condition with its line and pauses |
| `DBG_LOG("text")`, `DBG_TRACE()` | Messages and "this function ran" events with clickable locations |
| `DBG_MEMORY()` | Free RAM (AVR) or heap (ESP) as a watch |

With **Debug build** off, all of these compile to nothing, so they can stay in your code.
The helpers talk over the serial port, so the sketch must call `Serial.begin(...)` at the baud rate selected in the Serial Monitor.

Hardware step-debugging (JTAG/SWD with GDB) is not possible from a browser; the serial debugger covers the common cases without extra hardware.

## Adding boards and libraries

**Boards.** Open the Boards view and click **+**. Enter a name, the board's FQBN (`vendor:architecture:board`, as listed by `arduino-cli board listall` or in the core's `boards.txt`), the Boards Manager URL for third-party cores, and how it uploads. The core is installed and cached on the first GitHub Actions build. Custom boards are saved in your browser.

**Libraries.** Search in the Libraries view and click **Add**, or paste a GitHub URL or .zip link. The names go into the sketch's `libraries.txt`, which the build installs before compiling:

```
# libraries.txt
Servo
DHT sensor library@1.4.6
https://github.com/user/MyLibrary.git
https://example.com/OtherLibrary.zip
```

You can also put a library's source files in the sketch's `src/` folder and include them with `#include "src/MyLib/MyLib.h"`.

**For the project.** To add a board to the built-in list for everyone, edit `public/js/boards.js`; to add an example, edit `public/js/examples.js`. Pull requests are welcome.

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
- `public/js/app.js`: workbench UI, editor, compile and upload flow, serial monitor
- `public/js/boards.js`: built-in board catalog and custom boards
- `public/js/examples.js`: examples and the `WebIDEDebug.h` serial debugger helper
- `public/js/debugger.js`: watches, breakpoints and the ESP32 crash decoder
- `public/js/plotter.js`: Serial Plotter
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
