# Simple Multicast Share

**The simple way to share files and notes on your local network.**

<details>
  <summary>Why??</summary>
  <p>
  My local network is an absolute zoo of hardware: a couple of PCs, MacBooks, an iPhone, tablets, and random Pis scattered everywhere. Half of them are legacy devices that refuse to talk to cloud services, and others are completely un-accounted (no Apple/Google logins). Copy-pasting text or flinging a quick file across them was driving me insane—and dumping API tokens onto public pastebins is obviously a huge YIKES.
  </p>
  <p>
  Tired of bloated solutions that demand Docker stacks, npx bloat, or sketchy .msi installers that pollute your filesystem with a gigabyte of junk, I wrote my own thing:
  </p>
  <p>
  A dead-simple, disposable, one-click LAN file/text drop. Think of it as a ultra-dumbed-down local Google Drive with basic inline editing and previewing. No login, no setup wizard (just allow port access on your firewall), and super easy to spin down when you're done.
  </p>
  <p>
  Data persistence? It’s literally just a single SQLite DB. Move the file, move your data.
  </p>
  <p>
  Port forwarding to the open internet? There's literally no auth. May the odds be ever in your favor.
  </p>
  <hr />
</details>


Simple Multicast Share is a self-contained LAN file manager designed to work
without accounts, a separate web server, or runtime setup. Download one binary,
run it, and open the advertised mDNS address from another device on the same
network.

- **One binary:** the Rust server and complete React interface are bundled together.
- **One database:** files, folders, notes, and preferences are stored in one SQLite file.
- **No setup:** mDNS is enabled by default, so there is no server configuration or IP address to remember.
- **Local-first:** share through a browser on your trusted home, studio, or office network.

## Quick start

1. Download the binary for your operating system.
2. Run it:

   ```text
   simple-multicast-share
   ```

3. On another device connected to the same local network, open:

   ```text
   http://<your-computer-name>.local:7777
   ```

The server binds to all network interfaces, discovers the computer name, and
advertises the web interface over mDNS automatically. Upload or drag and drop
files, organize them into folders, or create and edit notes directly in the browser. The adjacent
`simple-multicast-share.db` file contains all durable application data.

If a device does not support `.local` mDNS names, open the host computer's LAN IP
address instead. No application configuration is required.

## Features

- Create and edit notes or source/configuration text in a CodeMirror editor with automatic syntax highlighting
- Upload by picker or drag-and-drop, replace, rename, move, download, and recursively delete
- Browse for a move destination, including nested folders, parents, and the root
- Create folders and organize shared files
- Grid/list views and system/light/dark themes persisted in SQLite
- Browser previews for images, PDF, audio, video, and STL/OBJ/FBX/glTF/GLB 3D models
- Local Office previews for DOCX/DOCM, XLSX/XLSM/XLSB/XLS/ODS, and PPTX/PPTM/PPSX/PPSM/POTX/POTM
- UTF-8 source/config editing with optimistic revision checks
- Image crop and freehand, arrow, rectangle, and text annotations
- Read-only ZIP, TAR, TAR.GZ, TGZ, and GZ inspection with entry, size, and expansion guards
- mDNS advertisement as `<hostname>.local` and `_http._tcp.local`
- Debug database inspector for browsing schemas/rows and updating typed cells

The interactive 3D viewer provides orbit, pan, zoom, reset, grid, wireframe, and
animation playback. Self-contained STL, OBJ, FBX, glTF, and GLB files work
directly. Referenced OBJ material libraries, textures, and glTF buffers are
resolved from files and subfolders beside the model in the virtual file manager;
external internet resources are intentionally not fetched.

Office previews are rendered locally in the browser; document contents are never
sent to a cloud viewer. Legacy binary `.doc` and `.ppt` files require a native
conversion engine and therefore show download/save-as-modern-format guidance.
Spreadsheet previews cap rendered DOM output at 500 rows by 100 columns per sheet
to keep the interface responsive while preserving the original file in storage.
Modern zipped Office files also pass the server's archive entry, expanded-size,
and compression-ratio guards before rendering.

## Build

Prebuilt releases require no development tools. The following instructions are
only for building the project from source.

Requirements are a current Rust toolchain, Node.js, and Corepack.

```powershell
corepack pnpm install --frozen-lockfile
corepack pnpm build
cargo build --release
```

The web build must run before Cargo so `web\dist` is embedded. The resulting
`target\release\simple-multicast-share.exe` needs no web assets or Node.js at
runtime. The release profile favors a small distributable binary with size
optimization, full link-time optimization, a single codegen unit, stripped
symbols, and abort-on-panic behavior.

For development:

```powershell
cargo run -- --no-mdns --port 3000
corepack pnpm --filter web dev
```

The Vite development server proxies `/api` to `127.0.0.1:3000`.

## Command line

```text
simple-multicast-share [--port <PORT>] [--mdns|--no-mdns]
                       [--db <PATH>] [--hostname <NAME>]
```

- `--port` defaults to `7777`.
- mDNS is enabled by default; `--no-mdns` disables it.
- `--hostname` overrides the advertised host label.
- `--db` selects the SQLite file. By default, the executable name with a `.db`
  extension is created beside the executable.

The HTTP listener always binds to `0.0.0.0`. With the defaults, open
`http://<hostname>.local:7777` from another device when local mDNS is supported,
or use the host's LAN IP address.

## Storage and limits

The SQLite database is the single durable persistent store and should be backed up
as one unit. SQLite may create temporary `-wal` and `-shm` working files beside it
while the server is running; these are implementation details rather than separate
application data stores. Stop the server before copying the database for the
simplest consistent backup.

The application has no configured file upload cap and streams request bodies into
SQLite. SQLite's compiled BLOB maximum, its incremental BLOB API range, free disk
space, and operating-system limits remain unavoidable. Text editing is limited to
16 MiB and archive inspection to 100 MiB because those preview operations must
materialize content in memory. Archive expansion is additionally guarded against
excessive entries and decompression ratios.

## Security

There is deliberately **no authentication**. Anyone who can reach the port can
read, create, replace, move, and delete all content in the database. Run this only
on a trusted LAN and use host firewall rules to restrict network access. Do not
expose it directly to the internet.

The bug icon opens a live SQLite inspector. Its edits bypass normal file-manager
workflows, though SQLite constraints remain active, so invalid changes can make
data inaccessible. It does not permit arbitrary SQL or access to internal
`sqlite_*` tables. BLOB cells are edited as UTF-8 when valid and Base64 otherwise.
The inspector also shows the main database file size, WAL size, and reclaimable
free-page space. Its confirmed **Compact database** action checkpoints WAL and runs
`VACUUM`; this rewrites the database, may briefly block requests, and needs
temporary free disk space.

See [the API contract](web/API_CONTRACT.md) for endpoint details.

## Continuous integration and releases

Pull requests and pushes to `main` or `master` run frontend lint/tests/build plus
Rust formatting, tests, Clippy, and a locked release build. The workflow is defined
in `.github/workflows/ci.yml`.

Pushing a tag such as `v0.1.0` builds and publishes the standalone binary directly
for Windows x86-64, Linux x86-64, and macOS ARM64 with generated GitHub release
notes.