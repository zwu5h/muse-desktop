# Muse Desktop

Codex-artige Desktop-App für die **Muse Code CLI** — gebaut, weil die CLI weder Screenshots/Vision noch Einfügen per <kbd>Strg</kbd>+<kbd>V</kbd> beherrscht.

**Funktionen (V1):**

- Chat-UI im dunklen Meta-Look mit Sitzungen, Suche und Verlauf (lokal gespeichert)
- **Bilder per <kbd>Strg</kbd>+<kbd>V</kbd> einfügen** → Vision-Anhang (`muse exec --image`), plus Bild-Button und Datei-Dialog
- Arbeitsordner-Auswahl (`--workspace`), Modell-Feld, **Denk-Tiefe** (`--reasoning-effort`: Aus bis Ultra), **Freigabe-Modus** (`--approval-mode`)
- Streaming-Anzeige der CLI-Events, Tool-Aktivität einklappbar, Code-Blöcke mit Kopieren-Button
- Auto-Erkennung der echten Muse-Binary (umgeht den `.cmd`-Shim), optional manuell übersteuerbar

## Installation

### Voraussetzungen

- Windows 10/11 mit **WebView2** (in der Regel vorinstalliert)
- **Muse Code CLI** installiert und im PATH (`muse --version` muss im Terminal gehen)

### Variante A: Setup herunterladen (empfohlen)

1. Auf der [Releases-Seite](https://github.com/zwu5h/muse-desktop/releases) die neueste `Muse Desktop_*_x64-setup.exe` herunterladen.
2. Doppelklick → **nur für den aktuellen Benutzer** installieren (kein Admin nötig).
3. Beim ersten Start meldet sich ggf. **Windows SmartScreen**, weil die App nicht code-signiert ist: auf *„Weitere Informationen"* → *„Trotzdem ausführen"* klicken.
4. Im Startmenü **Muse Desktop** öffnen.

### Variante B: Portable .exe ohne Installation

Die Datei `muse-desktop.exe` aus dem Release einfach doppelklicken — keine Installation, keine Admin-Rechte.

### Variante C: Aus dem Quellcode bauen

Voraussetzungen zusätzlich: **Node.js 20+** und **Rust stable**.

```powershell
git clone https://github.com/zwu5h/muse-desktop.git
cd muse-desktop
npm install

# Entwickeln (mit Hot-Reload):
npm run tauri dev

# Installer + portable .exe bauen:
npm run tauri build
# → src-tauri/target/release/bundle/nsis/Muse Desktop_*_x64-setup.exe
# → src-tauri/target/release/muse-desktop.exe
```

Reine Web-Vorschau ohne CLI-Anbindung (zum Design-Testen): `npm run dev`.

## Ersteinrichtung (2 Minuten)

1. **Arbeitsordner wählen:** links auf `…` → Projektordner auswählen. Alle Prompts laufen mit diesem Ordner als `--workspace`.
2. **CLI prüfen:** oben links muss die Muse-Version stehen (z. B. `Muse Code 1.4.0`). Steht dort *„nicht gefunden"*, den Pfad zur echten Binary unten in der Sidebar eintragen, z. B. `C:\Users\<Name>\AppData\Local\Programs\muse\muse-bin-1.4.0-R4302.1.exe` (Dateiname enthält die Version und ändert sich bei Updates — dann greift wieder die Auto-Erkennung).
3. **Losschreiben:** Nachricht tippen, **<kbd>Strg</kbd>+<kbd>Enter</kbd>** sendet. Screenshot aus der Zwischenablage einfach mit **<kbd>Strg</kbd>+<kbd>V</kbd>** in das Eingabefeld pasten.
4. **Feintuning:** Denk-Tiefe per Pills (Low/Med/High/XHigh …), Freigabe-Modus in der Sidebar (`Bei Bedarf fragen` = Standard).

**Tastenkürzel:** <kbd>Strg</kbd>+<kbd>Enter</kbd> senden · <kbd>Strg</kbd>+<kbd>K</kbd> neuer Chat.

## Problemlösung

| Problem | Lösung |
|---|---|
| `muse CLI nicht gefunden` | CLI-Pfad-Feld in der Sidebar prüfen; `muse --version` im Terminal testen |
| SmartScreen-Warnung | *Weitere Informationen → Trotzdem ausführen* (kein Signing vorhanden) |
| Leeres Fenster / weißer Screen | WebView2-Laufzeit installieren |
| Antwort doppelt im Chat | Bitte als Issue melden inkl. Modell und Denk-Tiefe |

## Deinstallation

Setup-Version: *Einstellungen → Apps → Muse Desktop → Deinstallieren*. Portable Version: `.exe` einfach löschen. Chat-Verläufe liegen lokal im Browser-Speicher der App (localStorage) und werden mit der Deinstallation entfernt.

## Technik im Überblick

Das Tauri-Backend ([src-tauri/src/main.rs](src-tauri/src/main.rs)) startet pro Prompt `muse exec --json …` und streamt jede JSONL-Zeile als `muse-event` ans Frontend ([src/main.ts](src/main.ts)), das Antwort-Text (`run.output.delta`), Abschluss-Record (dedupliziert) und Tool-Events trennt.
