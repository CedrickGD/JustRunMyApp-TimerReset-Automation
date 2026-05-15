# Native host + shell design

## Goal

Let the browser extension own the web-page click logic, while a Windows-side helper controls startup execution and on/off state.

## Architecture

1. **Browser extension (MV3)**
   - Stores `enabled` state.
   - Injects content logic on the target JustRunMy.App page.
   - Clicks `Reset Timer?` when conditions match.
   - Talks to a native host using Chrome/Edge native messaging.

2. **Native host wrapper**
   - Installed on Windows.
   - Registered in Edge/Chrome via native messaging manifest.
   - Receives messages like `SET_ENABLED` and writes/update Scheduled Task state.
   - Can log outcomes sent back from the extension.

3. **Startup task**
   - Triggered at user logon.
   - Runs a hidden PowerShell helper.
   - Opens Edge to `https://justrunmy.app/panel/application/<APPLICATION_ID>/` only if enabled.

## Why native messaging

Extensions cannot directly create or remove Windows Scheduled Tasks by themselves. Chrome/Edge native messaging is the supported bridge between an extension and a local application, and it requires `nativeMessaging` permission in the extension plus a registered native host manifest on Windows.

## Windows side design

### Native host responsibilities
- Receive JSON messages over stdin/stdout.
- Handle:
  - `SET_ENABLED`
  - `CONTENT_RESULT`
  - optional `GET_STATUS`
- Call PowerShell or Task Scheduler APIs.
- Update a local config file and log file.

### Suggested host implementation options
- PowerShell wrapped by a `.bat` launcher.
- C# console app for cleaner stdio handling.

For reliability, C# is the better final version; PowerShell is okay for prototyping.

## Toggle flow

### Enable
1. User opens extension popup.
2. User turns on `Enabled`.
3. Extension saves local state.
4. Extension sends `SET_ENABLED: true` to native host.
5. Native host creates/enables Scheduled Task.

### Disable
1. User turns off `Enabled`.
2. Extension saves local state.
3. Extension sends `SET_ENABLED: false` to native host.
4. Native host disables or removes Scheduled Task.

## Run flow

1. User signs into Windows.
2. Scheduled Task starts hidden helper.
3. Helper launches Edge with target URL.
4. Extension content script runs on the target page.
5. Content script finds the `Reset Timer?` control and clicks it.
6. If a confirm dialog appears, it attempts a second click.
7. Result is sent back to background script.
8. Background script forwards result to native host for logging.

## Edge/Chrome registration

Windows requires a registry entry that points to the native messaging host manifest. Microsoft Edge documents `HKEY_CURRENT_USER\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\<host-name>` as the per-user registration path for a native messaging host manifest.

The host manifest contains:
- `name`
- `description`
- `path`
- `type: stdio`
- `allowed_origins` for the extension ID

Chrome’s native messaging docs describe the same model: the browser launches the host as a separate process and communicates over stdin/stdout, and the extension uses `runtime.connectNative()` or `runtime.sendNativeMessage()` with the `nativeMessaging` permission.

## Recommended final repo structure

- `extension/`
  - `manifest.json`
  - `background.js`
  - `content.js`
  - `popup.html`
  - `popup.js`
- `native-host/`
  - `JrmResetHost.exe` or `host.ps1`
  - `com.cedrick.jrmreset.json`
  - install script for registry
- `windows-helper/`
  - `ResetTimerStartup.ps1`
  - install/uninstall scripts

## Implementation order

1. Build extension popup + content click logic.
2. Test manually on the target page.
3. Add native host plumbing.
4. Add Scheduled Task enable/disable from native host.
5. Add logging and retry strategy.
6. Package installer.

