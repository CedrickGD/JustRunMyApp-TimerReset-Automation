// Drives content.js inside a controlled jsdom + fake-timer environment.
// Goal: prove that the new bounded-wait logic actually fires, and that
// benign Turnstile widgets don't false-trigger the captcha block.

import { JSDOM } from 'jsdom';
import FakeTimers from '@sinonjs/fake-timers';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const contentJsSource = readFileSync(
    join(__dirname, '..', 'extension', 'content.js'),
    'utf8'
);

const results = [];

function record(name, pass, detail = '') {
    results.push({ name, pass, detail });
    const tag = pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  ${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}

// Build a sandbox per scenario so state never leaks between tests.
function makeSandbox({ html = '<!doctype html><html><head><title>Panel</title></head><body></body></html>', title, storage = {}, captureMessages = [] }) {
    const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://justrunmy.app/panel/application/00000/' });
    const { window } = dom;
    if (title) window.document.title = title;

    const clock = FakeTimers.install({
        global: window,
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    });
    // jsdom's vm context keeps its own Date binding, so fake-timers' Date replacement
    // doesn't always reach the eval'd script. Force it.
    Object.defineProperty(window, 'Date', { value: global.Date, writable: true, configurable: true });

    let messageListener = null;
    const storageData = { ...storage };

    const chromeMock = {
        storage: {
            local: {
                get(keys, cb) {
                    const out = {};
                    const list = Array.isArray(keys) ? keys : [keys];
                    for (const k of list) out[k] = storageData[k];
                    if (cb) { cb(out); return undefined; }
                    return Promise.resolve(out);
                },
                set(obj, cb) {
                    Object.assign(storageData, obj);
                    if (cb) { cb(); return undefined; }
                    return Promise.resolve();
                }
            }
        },
        runtime: {
            sendMessage(msg) {
                captureMessages.push(msg);
            },
            onMessage: {
                addListener(fn) { messageListener = fn; }
            }
        }
    };
    window.chrome = chromeMock;

    // Load content.js into the window context.
    window.eval(contentJsSource);

    return {
        window,
        clock,
        storage: storageData,
        getStatus: () => {
            const el = window.document.querySelector('#jrm-status');
            return el ? el.innerHTML : '';
        },
        getBorderColor: () => window.document.querySelector('#jrm-status')?.parentElement?.style?.borderLeft || '',
        sendStartAutomation: () => messageListener?.({ action: 'START_AUTOMATION' }),
        cleanup: () => { clock.uninstall(); dom.window.close(); }
    };
}

async function flushMicrotasks(times = 5) {
    for (let i = 0; i < times; i++) await Promise.resolve();
}

// -------- SCENARIO 1: Blocking Cloudflare interstitial times out at 2 min --------
async function testCaptchaTimeout() {
    console.log('\n[1] Blocking Cloudflare interstitial → bounded 2-min wait');
    const messages = [];
    const env = makeSandbox({
        html: `<!doctype html><html><head><title>Just a moment...</title></head>
               <body><div id="cf-challenge-running">Checking your browser...</div></body></html>`,
        title: 'Just a moment...',
        storage: { enabled: true },
        captureMessages: messages
    });

    await flushMicrotasks();          // let chrome.storage.get callback resolve
    env.window.dispatchEvent(new env.window.Event('load'));
    await env.clock.tickAsync(2000);  // ~1.5s startup delay → first scan
    await flushMicrotasks();

    const earlyStatus = env.getStatus();
    record('Detects blocking captcha within first scan', earlyStatus.includes('Captcha Detected'),
           `status="${earlyStatus.slice(0, 80)}"`);

    // Advance well past the 120s budget.
    await env.clock.tickAsync(125_000);
    await flushMicrotasks();

    const finalStatus = env.getStatus();
    record('Captcha times out after 2 min', finalStatus.includes('CAPTCHA timed out'),
           `final="${finalStatus.slice(0, 80)}"`);

    const timeoutMsg = messages.find(m => m.type === 'CONTENT_RESULT' && m.reason === 'captcha_timeout');
    record('Sends CONTENT_RESULT with reason=captcha_timeout', !!timeoutMsg,
           timeoutMsg ? JSON.stringify(timeoutMsg) : 'no such message');

    env.cleanup();
}

// -------- SCENARIO 2: Benign embedded Turnstile widget does NOT block --------
async function testBenignTurnstile() {
    console.log('\n[2] Embedded Turnstile widget on a normal page → not blocking');
    const messages = [];
    const env = makeSandbox({
        // Real page-ish body: lots of text, buttons, an iframe for Turnstile.
        html: `<!doctype html><html><head><title>Application 00000 - JustRunMy</title></head>
               <body>
                 <header>
                   <nav><a href="/">Home</a><a href="/account">Account</a></nav>
                 </header>
                 <main>
                   <h1>Application Details</h1>
                   <p>Welcome back. Manage your timers, schedules, runs and history below.
                      ${'Filler content. '.repeat(40)}</p>
                   <section>
                     <button>Settings</button>
                     <button>History</button>
                     <button>Reset Timer</button>
                     <button>Cancel</button>
                   </section>
                   <iframe src="https://challenges.cloudflare.com/turnstile/v0/api.js" style="width:300px;height:65px"></iframe>
                 </main>
               </body></html>`,
        storage: { enabled: true, jrm_last_trigger_time: -60_000 }, // negative = past cooldown under fake-time
        captureMessages: messages
    });

    await flushMicrotasks();
    env.window.dispatchEvent(new env.window.Event('load'));
    await env.clock.tickAsync(2000);
    await flushMicrotasks();
    await env.clock.tickAsync(500);
    await flushMicrotasks();

    const status = env.getStatus();
    record('Does NOT show "Captcha Detected"', !status.includes('Captcha Detected'),
           `status="${status.slice(0, 80)}"`);
    record('Proceeds to action on Reset Timer button',
           status.includes('Triggering Reset') || status.includes('Monitoring') || status.includes('Cooling') ||
           status.includes('Modal') || status.includes('verified') || status.includes('Already reset'),
           `status="${status.slice(0, 80)}"`);

    env.cleanup();
}

// -------- SCENARIO 3: No buttons ever appear → monitoring times out at 60s --------
async function testMonitoringTimeout() {
    console.log('\n[3] Page never produces Reset button → monitoring times out at 60s');
    const messages = [];
    const env = makeSandbox({
        html: `<!doctype html><html><head><title>JustRunMy</title></head>
               <body><div>${'Some unrelated content. '.repeat(50)}</div></body></html>`,
        storage: { enabled: true },
        captureMessages: messages
    });

    await flushMicrotasks();
    env.window.dispatchEvent(new env.window.Event('load'));
    await env.clock.tickAsync(2000);
    await flushMicrotasks();

    const earlyStatus = env.getStatus();
    record('Enters monitoring state', earlyStatus.includes('Monitoring'),
           `status="${earlyStatus.slice(0, 80)}"`);

    // Advance well past the 60s monitoring budget.
    await env.clock.tickAsync(65_000);
    await flushMicrotasks();

    const finalStatus = env.getStatus();
    record('Monitoring times out at 60s', finalStatus.includes('No Reset button'),
           `final="${finalStatus.slice(0, 80)}"`);

    const timeoutMsg = messages.find(m => m.type === 'CONTENT_RESULT' && m.reason === 'no_buttons_found');
    record('Sends CONTENT_RESULT with reason=no_buttons_found', !!timeoutMsg,
           timeoutMsg ? JSON.stringify(timeoutMsg) : 'no such message');

    env.cleanup();
}

// -------- SCENARIO 4: Reset Timer button present and past cooldown → click --------
async function testHappyPath() {
    console.log('\n[4] Reset Timer button visible, past cooldown → forceClick fires');
    const messages = [];
    const env = makeSandbox({
        html: `<!doctype html><html><head><title>JustRunMy</title></head>
               <body>
                 <h1>Application</h1>
                 <p>Some content here ${'lorem '.repeat(20)}</p>
                 <button id="rt">Reset Timer</button>
               </body></html>`,
        // jrm_last_trigger_time well in the past (fake-time starts at 0, so use negative).
        storage: { enabled: true, jrm_last_trigger_time: -60_000 },
        captureMessages: messages
    });

    // Track clicks on the button.
    let clicks = 0;
    const btn = env.window.document.getElementById('rt');
    // jsdom getBoundingClientRect returns zeroes by default — patch it so the visibility check passes.
    btn.getBoundingClientRect = () => ({ left: 10, top: 10, width: 120, height: 40, right: 130, bottom: 50, x: 10, y: 10 });
    Object.defineProperty(btn, 'offsetWidth', { value: 120, configurable: true });
    Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true });
    btn.addEventListener('click', () => clicks++);

    await flushMicrotasks();
    env.window.dispatchEvent(new env.window.Event('load'));
    await env.clock.tickAsync(2000);
    await flushMicrotasks();
    await env.clock.tickAsync(500);
    await flushMicrotasks();
    // Give one more scan iteration in case the first hit hit a sub-cooldown branch.
    await env.clock.tickAsync(2000);
    await flushMicrotasks();

    record('Reset Timer button got clicked', clicks > 0, `clicks=${clicks}`);
    record('Cooldown timestamp written to storage',
        typeof env.storage.jrm_last_trigger_time === 'number' && env.storage.jrm_last_trigger_time > 0,
        `stored=${env.storage.jrm_last_trigger_time}`);

    env.cleanup();
}

// -------- SCENARIO 5: Captcha clears mid-run → monitoring budget resets --------
async function testCaptchaThenRecovery() {
    console.log('\n[5] Captcha appears for 30s, clears, page slow to load → no premature timeout');
    const messages = [];
    const env = makeSandbox({
        html: `<!doctype html><html><head><title>Just a moment...</title></head>
               <body><div id="cf-challenge-running">Checking...</div></body></html>`,
        title: 'Just a moment...',
        storage: { enabled: true },
        captureMessages: messages
    });

    await flushMicrotasks();
    env.window.dispatchEvent(new env.window.Event('load'));
    await env.clock.tickAsync(2000);
    await flushMicrotasks();
    record('Captcha state entered', env.getStatus().includes('Captcha Detected'),
           `status="${env.getStatus().slice(0, 80)}"`);

    // Sit in captcha for ~30s.
    await env.clock.tickAsync(30_000);
    await flushMicrotasks();

    // User solves the challenge: swap the DOM to a clean (but still button-less) page.
    env.window.document.title = 'Application';
    env.window.document.body.innerHTML = `<div>${'Loading content '.repeat(30)}</div>`;

    // Now wait 45 more seconds (less than the 60s monitoring budget from when captcha cleared).
    await env.clock.tickAsync(45_000);
    await flushMicrotasks();

    const status = env.getStatus();
    record('Still monitoring after captcha clear (no premature timeout)',
        status.includes('Monitoring') && !status.includes('No Reset button'),
        `status="${status.slice(0, 80)}"`);

    env.cleanup();
}

// -------- SCENARIO 6: Button wrapped in a div — must click BUTTON not wrapper --------
async function testWrappedButton() {
    console.log('\n[6] Reset Timer button wrapped in a div → real button gets the click, not wrapper');
    const messages = [];
    const env = makeSandbox({
        html: `<!doctype html><html><head><title>JustRunMy</title></head>
               <body>
                 <h1>Application</h1>
                 <p>${'lorem '.repeat(20)}</p>
                 <div class="card"><div class="row">
                   <span>Status: running</span>
                   <button id="rt" class="primary"><span class="icon">⟳</span> Reset Timer</button>
                 </div></div>
               </body></html>`,
        storage: { enabled: true, jrm_last_trigger_time: -60_000 },
        captureMessages: messages
    });

    const btn = env.window.document.getElementById('rt');
    btn.getBoundingClientRect = () => ({ left: 10, top: 10, width: 120, height: 40, right: 130, bottom: 50, x: 10, y: 10 });
    Object.defineProperty(btn, 'offsetWidth', { value: 120, configurable: true });
    Object.defineProperty(btn, 'offsetHeight', { value: 40, configurable: true });
    let buttonClicks = 0;
    btn.addEventListener('click', () => buttonClicks++);

    // The wrapper divs also have the text "Reset Timer" (because of textContent inheritance).
    // Track clicks on them to prove we did NOT click them.
    const card = env.window.document.querySelector('.card');
    const row = env.window.document.querySelector('.row');
    Object.defineProperty(card, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(card, 'offsetHeight', { value: 80, configurable: true });
    Object.defineProperty(row, 'offsetWidth', { value: 400, configurable: true });
    Object.defineProperty(row, 'offsetHeight', { value: 80, configurable: true });
    let clickTargetTag = null;
    card.addEventListener('click', (e) => {
        if (!clickTargetTag) clickTargetTag = e.target.tagName;
    });

    await flushMicrotasks();
    env.window.dispatchEvent(new env.window.Event('load'));
    await env.clock.tickAsync(2000);
    await flushMicrotasks();
    await env.clock.tickAsync(2000);
    await flushMicrotasks();

    record('Actual <button> received click', buttonClicks > 0, `buttonClicks=${buttonClicks}`);
    record('Click target was the BUTTON (not a wrapper div)',
        clickTargetTag === 'BUTTON', `target=${clickTargetTag}`);

    env.cleanup();
}

(async () => {
    console.log('═══ JRM Reset Timer — content.js test suite ═══');
    await testCaptchaTimeout();
    await testBenignTurnstile();
    await testMonitoringTimeout();
    await testHappyPath();
    await testCaptchaThenRecovery();
    await testWrappedButton();

    const failed = results.filter(r => !r.pass);
    const passed = results.length - failed.length;
    console.log(`\n──────── ${passed}/${results.length} checks passed ────────`);
    if (failed.length) {
        console.log('\nFailures:');
        for (const f of failed) console.log(`  ✘ ${f.name}: ${f.detail}`);
        process.exit(1);
    }
})();
