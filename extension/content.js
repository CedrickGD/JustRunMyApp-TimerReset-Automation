(function() {
    console.log("JRM Reset Timer Automation: PERFORMANCE MODE v2");

    const COOLDOWN_KEY = 'jrm_last_trigger_time';
    const MANUAL_RUN_KEY = 'manual_run_pending';
    const INITIAL_COOLDOWN_MS = 5000;
    const MODAL_WAIT_MS = 3000;
    const CAPTCHA_MAX_WAIT_MS = 120000; // 2 minutes for a human to solve
    const MONITORING_MAX_MS = 60000;    // 60s with no buttons found = give up
    const SCAN_INTERVAL_MS = 1500;
    const CAPTCHA_SCAN_INTERVAL_MS = 2000;

    const overlay = document.createElement('div');
    overlay.style = `
        position: fixed; top: 20px; right: 20px; padding: 16px;
        background: rgba(15, 15, 15, 0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
        color: white; z-index: 999999; border-radius: 12px; font-size: 14px; font-family: sans-serif;
        border: 1px solid rgba(255, 255, 255, 0.15); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        min-width: 240px; transition: border-left 0.3s ease;
    `;
    overlay.innerHTML = '<div style="font-weight: 700; margin-bottom: 6px; color: #3498db;">JRM AUTOMATION</div><div id="jrm-status" style="font-weight: 400;">Initializing...</div>';

    function mountOverlay() {
        if (document.body && !overlay.isConnected) {
            document.body.appendChild(overlay);
        }
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mountOverlay, { once: true });
    } else {
        mountOverlay();
    }

    const statusEl = overlay.querySelector('#jrm-status');
    let isClosing = false;
    let isFatallyStopped = false;
    let hasClickedJustResetThisSession = false;
    let lastJustResetClick = 0;
    let captchaFirstSeenAt = 0;
    let monitoringStartedAt = 0;

    function log(msg, accentColor = '#3498db') {
        if (isClosing && accentColor !== '#2ecc71' && accentColor !== '#e74c3c') return;
        mountOverlay();
        if (statusEl) statusEl.innerHTML = msg;
        overlay.style.borderLeft = `5px solid ${accentColor}`;
    }

    function findTargetElement(searchText, exactMatch = false) {
        function matches(el) {
            const text = el.textContent;
            if (!text) return false;
            if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) return false;
            return exactMatch ? text.trim() === searchText : text.includes(searchText);
        }
        // Pass 1: real click targets first — clicking a wrapper <div> doesn't trigger
        // React's onClick on the button inside.
        for (const sel of ['button', '[role="button"]', 'a']) {
            for (const el of document.querySelectorAll(sel)) {
                if (matches(el)) return el;
            }
        }
        // Pass 2: fall back to text-matching containers, but prefer a clickable descendant.
        for (const el of document.querySelectorAll('span, div')) {
            if (matches(el)) {
                const inner = el.querySelector('button, [role="button"], a');
                if (inner && matches(inner)) return inner;
                return el;
            }
        }
        return null;
    }

    function forceClick(el) {
        if (!el) return;
        el.style.outline = '5px solid #2ecc71';
        const rect = el.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: centerX, clientY: centerY }));
        ['mousedown', 'mouseup', 'click'].forEach(name => {
            el.dispatchEvent(new MouseEvent(name, { view: window, bubbles: true, cancelable: true, buttons: 1, clientX: centerX, clientY: centerY }));
        });
        el.click();
    }

    // Distinguish a BLOCKING Cloudflare challenge from a benign Turnstile widget
    // that's embedded on a fully-loaded page.
    function isBlockingCaptcha() {
        const title = (document.title || '').toLowerCase();
        if (title.includes("just a moment") || title.includes("attention required")) return true;
        if (document.querySelector("#cf-challenge-running, #challenge-form, #challenge-stage, .cf-browser-verification, .cf-im-under-attack")) return true;

        const turnstile = document.querySelector('iframe[src*="challenges.cloudflare.com"]');
        if (turnstile) {
            const bodyText = document.body ? document.body.textContent.trim() : '';
            // Heuristic: a real challenge page has very little body text and challenge wording.
            // A normal page with an embedded Turnstile widget has plenty of other content.
            if (bodyText.length < 400 && /verify|moment|checking|browser|are human/i.test(bodyText)) return true;
        }
        return false;
    }

    function startExitCountdown(seconds) {
        if (isClosing) return;
        isClosing = true;
        let remaining = seconds;

        const updateCountdown = () => {
            if (remaining <= 0) {
                log(`<span style="color: #2ecc71; font-weight: bold;">✔ TASK COMPLETE</span><br>Closing now...`, "#2ecc71");
                chrome.runtime.sendMessage({ type: 'CLOSE_TAB' });
            } else {
                log(`<span style="color: #2ecc71; font-weight: bold;">✔ RESET VERIFIED</span><br>Closing in ${remaining}s...`, "#2ecc71");
                remaining--;
                setTimeout(updateCountdown, 1000);
            }
        };
        updateCountdown();
    }

    function fatalStop(reason, displayMsg) {
        if (isFatallyStopped) return;
        isFatallyStopped = true;
        log(`<span style="color: #e74c3c; font-weight: bold;">✘ ${displayMsg}</span><br>Automation halted — fix and reload.`, "#e74c3c");
        try {
            chrome.runtime.sendMessage({ type: 'CONTENT_RESULT', success: false, reason });
        } catch (_) {}
    }

    async function scan() {
        if (isClosing || isFatallyStopped) return;
        if (!document.body) {
            setTimeout(scan, 500);
            return;
        }

        const storage = await chrome.storage.local.get([COOLDOWN_KEY]);
        const lastInitialTrigger = storage[COOLDOWN_KEY] || 0;
        const bodyText = document.body.textContent;
        const now = Date.now();
        const timeSinceInitialTrigger = now - lastInitialTrigger;

        // 1. BLOCKING CAPTCHA (bounded so we don't loop forever if no human is there)
        if (isBlockingCaptcha()) {
            if (!captchaFirstSeenAt) captchaFirstSeenAt = now;
            const elapsed = now - captchaFirstSeenAt;

            if (elapsed > CAPTCHA_MAX_WAIT_MS) {
                fatalStop('captcha_timeout', 'CAPTCHA timed out');
                return;
            }
            const secondsLeft = Math.ceil((CAPTCHA_MAX_WAIT_MS - elapsed) / 1000);
            log(`STATUS: Captcha Detected<br>Solve it (${secondsLeft}s left)`, "#f39c12");
            setTimeout(scan, CAPTCHA_SCAN_INTERVAL_MS);
            return;
        }
        if (captchaFirstSeenAt) {
            // Captcha just cleared — reset the monitoring budget so the page gets a fresh chance.
            captchaFirstSeenAt = 0;
            monitoringStartedAt = 0;
        }

        // 2. SUCCESS CHECK
        const timerMatch = bodyText.match(/(\d)\s*days\s*(\d{1,2}):(\d{2})/i);
        let isPerfectlyFull = false;
        let isRecentlyReset = false;
        if (timerMatch) {
            const days = parseInt(timerMatch[1]);
            const hours = parseInt(timerMatch[2]);
            const mins = parseInt(timerMatch[3]);
            isPerfectlyFull = (days === 3) || (days === 2 && hours === 23 && mins === 59);
            isRecentlyReset = (days === 2 && hours === 23);
        }

        const modalVisible = !!document.querySelector('.modal, [class*="modal"], [class*="overlay"]');

        if (!modalVisible) {
            if (isPerfectlyFull && !hasClickedJustResetThisSession) {
                log("STATUS: Timer already full.<br>Verified.", "#2ecc71");
                startExitCountdown(2);
                return;
            }
            if (hasClickedJustResetThisSession && isRecentlyReset) {
                chrome.runtime.sendMessage({ type: 'CONTENT_RESULT', success: true });
                startExitCountdown(2);
                return;
            }
        }

        // 3. JUST RESET (confirm modal)
        const justReset = findTargetElement("Just Reset", true);
        if (justReset) {
            monitoringStartedAt = 0;
            if (timeSinceInitialTrigger < MODAL_WAIT_MS) {
                const waitRemaining = Math.ceil((MODAL_WAIT_MS - timeSinceInitialTrigger) / 1000);
                log(`STATUS: Modal Ready<br>Safety Delay: ${waitRemaining}s`, "#f1c40f");
                setTimeout(scan, 800);
                return;
            }
            if (now - lastJustResetClick < 5000) {
                log("STATUS: Waiting for Just Reset to process...", "#f39c12");
                setTimeout(scan, 1000);
                return;
            }
            log("ACTION: Clicking 'Just Reset'", "#2ecc71");
            forceClick(justReset);
            hasClickedJustResetThisSession = true;
            lastJustResetClick = now;
            setTimeout(scan, 1000);
            return;
        }

        // 4. INITIAL RESET TIMER BUTTON
        const resetBtn = findTargetElement("Reset Timer", false);
        if (resetBtn && !resetBtn.textContent.includes("Just")) {
            monitoringStartedAt = 0;
            if (isPerfectlyFull) {
                log("STATUS: Already reset.<br>Preparing to close...", "#2ecc71");
                startExitCountdown(3);
                return;
            }
            if (timeSinceInitialTrigger < INITIAL_COOLDOWN_MS) {
                const cooldownRemaining = Math.ceil((INITIAL_COOLDOWN_MS - timeSinceInitialTrigger) / 1000);
                log(`STATUS: Cooling down<br>Wait: ${cooldownRemaining}s`, "#3498db");
                setTimeout(scan, 1000);
                return;
            }
            log("ACTION: Triggering Reset", "#2ecc71");
            await chrome.storage.local.set({ [COOLDOWN_KEY]: now });
            hasClickedJustResetThisSession = false;
            forceClick(resetBtn);
            setTimeout(scan, 1500);
            return;
        }

        // 5. MONITORING (bounded — don't poll forever if the page never produces the button)
        if (!monitoringStartedAt) monitoringStartedAt = now;
        const monitoringElapsed = now - monitoringStartedAt;
        if (monitoringElapsed > MONITORING_MAX_MS) {
            fatalStop('no_buttons_found', 'No Reset button found');
            return;
        }
        const secondsRemaining = Math.ceil((MONITORING_MAX_MS - monitoringElapsed) / 1000);
        log(`STATUS: Monitoring Page... (${secondsRemaining}s)`, "#3498db");
        setTimeout(scan, SCAN_INTERVAL_MS);
    }

    function startWhenReady() {
        const begin = () => setTimeout(scan, 1500); // small SPA-hydration grace period
        if (document.readyState === 'complete') {
            begin();
        } else {
            window.addEventListener('load', begin, { once: true });
        }
    }

    chrome.storage.local.get(['enabled', MANUAL_RUN_KEY], (r) => {
        const manualPending = !!r[MANUAL_RUN_KEY];
        if (r.enabled || manualPending) {
            if (manualPending) {
                // Consume the one-shot manual trigger so it doesn't leak into the next load.
                chrome.storage.local.set({ [MANUAL_RUN_KEY]: false });
            }
            log("Initializing...", "#3498db");
            startWhenReady();
        } else {
            log("STATUS: Disabled", "#7f8c8d");
        }
    });

    chrome.runtime.onMessage.addListener(async (msg) => {
        if (msg.action === 'START_AUTOMATION') {
            await chrome.storage.local.set({ [COOLDOWN_KEY]: 0 });
            hasClickedJustResetThisSession = false;
            isClosing = false;
            isFatallyStopped = false;
            captchaFirstSeenAt = 0;
            monitoringStartedAt = 0;
            scan();
        }
    });
})();
