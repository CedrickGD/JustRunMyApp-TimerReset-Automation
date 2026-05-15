const statusText = document.getElementById('statusText');
const toggleBtn = document.getElementById('toggleBtn');
const manualBtn = document.getElementById('manualBtn');

function updateUI(enabled) {
    statusText.textContent = enabled ? 'Enabled' : 'Disabled';
    statusText.className = enabled ? 'enabled' : 'disabled';
    toggleBtn.textContent = enabled ? 'Disable Auto-Run' : 'Enable Auto-Run';
}

// Initial load
chrome.storage.local.get(['enabled'], (result) => {
    updateUI(!!result.enabled);
});

toggleBtn.addEventListener('click', () => {
    chrome.storage.local.get(['enabled'], (result) => {
        const newState = !result.enabled;
        chrome.runtime.sendMessage({ type: 'SET_ENABLED', enabled: newState }, (response) => {
            // Success response might not come back if background script is busy, 
            // but we can update UI based on our intent.
            updateUI(newState);
        });
    });
});

const TARGET_URL = `https://justrunmy.app/panel/application/${self.JRM_CONFIG.APPLICATION_ID}/`;

manualBtn.addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const activeTab = tabs[0];
        // Flag a one-shot manual run so content.js scans even if auto-mode is off.
        const flags = { 'jrm_last_trigger_time': 0, 'manual_run_pending': true };
        if (activeTab && activeTab.url && activeTab.url.includes("justrunmy.app/panel/application/")) {
            console.log("Manual trigger: Clearing cooldown and refreshing tab...");
            chrome.storage.local.set(flags, () => {
                chrome.tabs.reload(activeTab.id);
                window.close();
            });
        } else {
            console.log("Manual trigger: Opening new tab...");
            chrome.storage.local.set(flags, () => {
                chrome.tabs.create({ url: TARGET_URL });
                window.close();
            });
        }
    });
});
