# JustRunMyApp Timer Reset Automation

A Chromium browser extension + Windows native messaging host that automatically clicks the **Reset Timer** button on [JustRunMy.App](https://justrunmy.app) panel pages, then closes the tab. Works in Chrome, Edge, and Comet.

## Why

JustRunMy.App's free tier requires you to click "Reset Timer" before the auto-stop countdown expires. This project automates that click reliably, with bounded waits for Cloudflare captchas and clear failure modes when something is off.

## Architecture

```
┌─────────────────────────────────────────┐
│ Browser extension (MV3)                 │
│  ├─ content.js — finds & clicks button  │
│  ├─ background.js — service worker      │
│  └─ popup.html — toggle + manual run    │
└──────────────┬──────────────────────────┘
               │ chrome.runtime.sendNativeMessage
┌──────────────▼──────────────────────────┐
│ Native host (PowerShell)                │
│  └─ host.ps1 — persists enabled state   │
│      + creates Startup shortcut         │
└──────────────┬──────────────────────────┘
               │ writes config.json
┌──────────────▼──────────────────────────┐
│ Windows helper (Startup shortcut)       │
│  └─ ResetTimerStartup.ps1               │
│      launches browser at user logon     │
└─────────────────────────────────────────┘
```

The content script does the actual page interaction. The native host exists so toggling "Enable" in the extension popup can register/unregister a logon-time Startup shortcut that opens the panel page automatically — which is something an extension cannot do on its own.

## Setup

### 1. Configure the extension

```powershell
Copy-Item extension/config.example.js extension/config.js
```

Edit `extension/config.js` and set `APPLICATION_ID` to the number from your panel URL (the part after `/application/`).

### 2. Load the extension in your browser

1. Open `chrome://extensions/` (or `edge://extensions/`, `comet://extensions/`).
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `extension/` folder.
4. Copy the extension ID shown on the card — you need it in step 4.

### 3. Configure the Windows helper

```powershell
Copy-Item windows-helper/config.example.json windows-helper/config.json
```

Edit `windows-helper/config.json` and set `targetUrl` to your panel URL.

### 4. Register the native host

Edit `native-host/com.cedrick.jrmreset.json` and replace `YOUR_EXTENSION_ID_HERE` with the ID from step 2. Then in PowerShell:

```powershell
cd native-host
.\register.ps1
```

This writes `HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.cedrick.jrmreset` and `HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.cedrick.jrmreset` pointing at the manifest JSON.

> Comet uses Chrome's registry path, so the Chrome entry covers it.

### 5. Turn it on

Open the extension popup, click **Toggle Automation** to enable. This sends `SET_ENABLED: true` to the native host, which writes `native-host/config.json` (runtime state) and creates a Startup shortcut at `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\JRMResetTimer.lnk`.

After the next logon, the helper will open the panel URL in Comet (or your default browser), the content script will click Reset Timer, then close the tab.

## Usage

### Auto-run at logon
Once enabled (step 5), runs at every Windows logon. The script has a 12-hour periodic alarm too, in case the machine stays logged in for days.

### Manual run
Click the extension icon → **Run Reset Now**. This works even if Auto-Run is off (one-shot trigger).

## How it handles things

| Situation | Behavior |
|---|---|
| Cloudflare full-page interstitial | Waits up to 2 min for a human, then stops with a clear error |
| Embedded Turnstile widget on a normal page | Ignored — not treated as blocking |
| Timer already perfectly full | Exits cleanly without clicking |
| "Reset Timer" button not found in 60s | Stops with "No Reset button found" |
| Just-clicked reset | 30s cooldown prevents double-click |
| Confirm modal ("Just Reset") | Waits 5s safety delay, then clicks once |

## Tests

```powershell
cd test
npm install
node run.mjs
```

5 scenarios, 12 assertions covering captcha detection, bounded timeouts, happy-path click, and captcha→recovery transitions. Uses [jsdom](https://github.com/jsdom/jsdom) + [@sinonjs/fake-timers](https://github.com/sinonjs/fake-timers).

## Troubleshooting

**`native-host/config.json` never appears** → native messaging isn't connecting. Most common causes:
- `allowed_origins` in `com.cedrick.jrmreset.json` doesn't match your actual extension ID, or is missing the `chrome-extension://...` prefix
- `register.ps1` wasn't run, or was run before you edited the manifest
- The browser was opened before the registry entry existed — restart the browser

**`startup.log` says "URL config not found"** → you skipped step 3.

**Browser opens but nothing happens** → check the overlay top-right of the panel page. If it says "Disabled", toggle the popup. If it sticks on "Monitoring Page", the page probably needs you to log in.

## Files

```
extension/
  manifest.json
  config.example.js     copy → config.js, edit
  config.js             [gitignored] your local values
  background.js         service worker (alarm + native messaging)
  content.js            page interaction
  popup.html, popup.js  enable/disable + manual run
native-host/
  com.cedrick.jrmreset.json   edit allowed_origins
  host.ps1                    receives SET_ENABLED, manages startup shortcut
  launch.bat                  bootstrap stub for native messaging
  register.ps1                writes the HKCU registry entry
windows-helper/
  config.example.json   copy → config.json, edit
  config.json           [gitignored] your local URL
  ResetTimerStartup.ps1 launched by Startup shortcut
test/
  run.mjs               jsdom-based test harness
  package.json
native-host-plan.md     original design notes
```

## License

MIT
