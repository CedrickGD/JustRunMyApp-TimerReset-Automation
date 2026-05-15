// Copy this file to `config.js` and fill in your values.
// `config.js` is gitignored so your IDs never get committed.
self.JRM_CONFIG = {
    // The numeric application ID from your JustRunMy.App panel URL.
    // e.g. https://justrunmy.app/panel/application/12345/  →  "12345"
    APPLICATION_ID: "YOUR_APPLICATION_ID",

    // The native-messaging host name. Must match `name` in
    // native-host/<host-name>.json AND the HKCU registry entry that
    // register.ps1 creates. Default keeps the project's existing name.
    NATIVE_HOST: "com.cedrick.jrmreset"
};
