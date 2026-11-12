<p align="center"><img src="docs/assets/banner.svg" alt="LYNX MCP · Local music tools for LYNX SHARE" width="840"></p>

<p align="center"><a href="../../releases/latest">Download for Windows x64</a> · <a href="docs/INSTALL.md">Installation guide</a> · <a href="#build-from-source">Build from source</a></p>

LYNX MCP connects an MCP client to [LYNX SHARE](https://github.com/Ka1-S/LYNX-SHARE). Create a song from scratch, arrange a saved project, or bounce it to audio from your client. The optional CLAP panel lets you toggle the tools and select a MIDI output inside LYNX.

| Workflow | What you can do |
| --- | --- |
| Compose | Create projects and MIDI, add instruments and notes, and place patterns in the Playlist |
| Edit | Read patterns and clips, change tempo and routing, and update mixer settings and existing automation, inspect arrangements, set loops, and relink samples |
| Export | Render WAV, FLAC, and OGG, export mixer stems, transcribe audio to notes, or convert to FL Studio and Ableton Live |
| Control live | Send transport, mixer, channel, sequencer, and instrument commands through a MIDI loopback port |
| Review audio | Play a short WAV excerpt and measure peak, RMS, near silence, full-scale samples, and stereo correlation |
| Diagnose | List audio devices, scan or test trusted plugins, check audio outputs, and capture LYNX interface snapshots |

The server exposes **50 tools**. Detailed arrangement edits write a new project file beside the source so relative sample paths stay valid. Live commands require a configured MIDI loopback and report message delivery to Windows.

## Quick start

Install Node.js 20+ and LYNX SHARE, extract the [Windows release](../../releases/latest), and follow the [installation guide](docs/INSTALL.md). Then ask your client: “Create a four-bar drum and bass loop in LYNX, save the project, and export it to WAV.”

## Build from source

Run `./build.ps1` in PowerShell with Zig 0.14.1 on PATH. The Windows x64 package is written to `dist/`. The vendored CLAP headers include their [upstream license](third_party/clap/LICENSE).

Made by **Localrcc**.
