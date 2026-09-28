# Muse Desktop

Codex-like Desktop-Harness für die **Muse Code CLI** — gebaut weil die CLI kein Vision hat und man nichts pasten kann.

## Was V1 kann

- Chat-UI im Meta/Muse-Look (dunkel, Meta-Blau)
- **Bilder pasten (Strg+V)** → Vision-Anhang via `muse exec --image`
- Bild-Button + Datei-Dialog als Alternative
- Arbeitsordner wählen → `muse exec --workspace`
- Sitzungen (lokal gespeichert), Streaming-Anzeige der JSONL-Events
- CLI-Status (`muse --version`) in der Sidebar

## Voraussetzung

- `muse` CLI im PATH (`muse --version` muss gehen)
- Node 20+, Rust stable

## Start

```powershell
npm install
npm run tauri dev
```

Reine Web-Vorschau (ohne CLI-Anbindung):

```powershell
npm install
npm run dev
```

## Wie es funktioniert

Das Tauri-Backend (`src-tauri/src/main.rs`) spawnt pro Prompt:

```
muse exec --json --workspace <ordner> [--image <pfad> ...] [--model <id>] <prompt>
```

Jede stdout-Zeile (JSONL) wird als `muse-event` ans Frontend gestreamt und dort in Text bzw. Tool-Hinweise zerlegt. Gepastete Bilder landen per `save_pasted_image` in App-Data/attachments und werden als Pfad übergeben.
