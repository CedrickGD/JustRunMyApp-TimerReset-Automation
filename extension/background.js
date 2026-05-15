importScripts('config.js');
const HOST_NAME = self.JRM_CONFIG.NATIVE_HOST;
const TARGET_URL = `https://justrunmy.app/panel/application/${self.JRM_CONFIG.APPLICATION_ID}/`;

// Alarm for periodic checks (every 12 hours)
chrome.alarms.create('periodicResetCheck', { periodInMinutes: 720 });

chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'periodicResetCheck') {
        chrome.storage.local.get(['enabled'], (result) => {
            if (result.enabled) {
                console.log("JRM Reset Timer Automation: Periodic alarm triggered. Opening reset page...");
                chrome.tabs.create({ url: TARGET_URL, active: false });
            }
        });
    }
});

// Handle extension icon click
chrome.action.onClicked.addListener((tab) => {
    if (tab.url.includes("justrunmy.app/panel/application/")) {
        console.log("JRM Reset Timer Automation: Icon clicked on target page. Refreshing and starting...");
        chrome.tabs.reload(tab.id);
    } else {
        console.log("JRM Reset Timer Automation: Icon clicked on non-target page.");
    }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("JRM Reset Timer Automation: Received message:", message);

    if (message.type === 'SET_ENABLED') {
        // Save to storage
        chrome.storage.local.set({ enabled: message.enabled }, () => {
            console.log("JRM Reset Timer Automation: Enabled set to", message.enabled);
            // Forward to native host
            sendToNativeHost(message);
            sendResponse({ status: 'success' });
        });
        return true; // Keep channel open for sendResponse
    }

    if (message.type === 'CONTENT_RESULT') {
        console.log("JRM Reset Timer Automation: Content script result:", message);
        // Forward result to native host for logging
        sendToNativeHost(message);
    }

    if (message.type === 'CLOSE_TAB') {
        console.log("JRM Reset Timer Automation: Targeted Close triggered.");
        if (sender.tab) {
            console.log("JRM Reset Timer Automation: Removing specific sender tab:", sender.tab.id);
            chrome.tabs.remove(sender.tab.id, () => {
                if (chrome.runtime.lastError) {
                    console.error("JRM Reset Timer Automation: Targeted removal failed, falling back to query.");
                    // Fallback to query only if targeted removal failed
                    chrome.tabs.query({ url: "*://justrunmy.app/*" }, (tabs) => {
                        if (tabs && tabs.length > 0) {
                            chrome.tabs.remove(tabs.map(t => t.id));
                        }
                    });
                }
            });
        }
    }
});

function sendToNativeHost(message) {
    try {
        console.log("JRM Reset Timer Automation: Sending to native host:", message);
        chrome.runtime.sendNativeMessage(HOST_NAME, message, (response) => {
            if (chrome.runtime.lastError) {
                console.warn("JRM Reset Timer Automation: Native host error:", chrome.runtime.lastError.message);
            } else {
                console.log("JRM Reset Timer Automation: Native host response:", response);
            }
        });
    } catch (e) {
        console.error("JRM Reset Timer Automation: Failed to send to native host:", e);
    }
}

// Check initial state or set default
chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(['enabled'], (result) => {
        if (result.enabled === undefined) {
            chrome.storage.local.set({ enabled: false });
        }
    });
});
