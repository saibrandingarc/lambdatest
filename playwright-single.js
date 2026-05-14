const path = require('path');
const fs = require('fs');
const os = require('os');
const readline = require('readline');
const cp = require('child_process');
const { chromium } = require('playwright');
const { ImapFlow } = require('imapflow');
const dotenv = require('dotenv');

dotenv.config();

/** True when running under a typical CI system (Azure Pipelines, GitHub Actions, etc.). */
function isCiEnvironment() {
  if (/^1|true|yes$/i.test(String(process.env.CI ?? '').trim())) return true;
  if (process.env.TF_BUILD) return true;
  if (process.env.GITHUB_ACTIONS) return true;
  if (process.env.AZURE_PIPELINES) return true;
  if (process.env.BUILD_BUILDID) return true;
  if (/^1|true|yes$/i.test(String(process.env.SKIP_LOCAL_DOTENV_MERGE ?? '').trim())) return true;
  return false;
}

/**
 * Merges every key from `.env` next to this file into `process.env` so repo config wins over the shell.
 * Skips `USE_LAMBDATEST` so `npm run test:lambdatest` (`USE_LAMBDATEST=1` on the command line) still works
 * when `.env` has `USE_LAMBDATEST=false` for local runs.
 * Skipped entirely in CI so Azure / GitHub injected variables are not overwritten by a checked-in `.env`.
 */
function mergeLocalDotenvOverProcessEnv() {
  try {
    const envFile = path.join(__dirname, '.env');
    const parsed = dotenv.parse(fs.readFileSync(envFile, 'utf8'));
    const skipKeys = new Set(['USE_LAMBDATEST']);
    for (const [key, value] of Object.entries(parsed)) {
      if (skipKeys.has(key)) continue;
      process.env[key] = String(value).trim();
    }
  } catch {
    /* .env missing or unreadable */
  }
}

if (!isCiEnvironment()) {
  mergeLocalDotenvOverProcessEnv();
}

/**
 * Adds the query flag used by the WordPress/PHP side to detect this automated run.
 * The flag needs to be present both on the page load and on CF7 submit requests.
 * @param {string} rawUrl
 * @returns {string}
 */
function withLambdaTestQueryParam(rawUrl) {
  const text = String(rawUrl || '').trim();
  if (!text) return text;

  try {
    const url = new URL(text);
    url.searchParams.set('lambdatest', '1');
    return url.toString();
  } catch {
    const hashIndex = text.indexOf('#');
    const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
    const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
    const separator = beforeHash.includes('?') ? '&' : '?';
    return `${beforeHash}${separator}lambdatest=1${hash}`;
  }
}

// --- env-backed flags ----------------------------------------------------------

const useLambdaTest = /^1|true|yes$/i.test(String(process.env.USE_LAMBDATEST ?? '').trim());
const headlessLocal = /^1|true|yes$/i.test(String(process.env.HEADLESS ?? '').trim());
const closeBrowserImmediately =
  useLambdaTest ||
  headlessLocal ||
  /^1|true|yes$/i.test(String(process.env.CLOSE_BROWSER ?? '').trim());

const CONTACT_PAGE_URL = withLambdaTestQueryParam(
  process.env.CONTACT_PAGE_URL || 'https://adamparksi1stg.wpenginepowered.com/contact-us/'
);
const verifyEmail = /^1|true|yes$/i.test(String(process.env.VERIFY_EMAIL ?? '').trim());
const emailVerifyTimeoutMs = Number(process.env.EMAIL_VERIFY_TIMEOUT_MS || 120000);
const emailVerifyPollMs = Number(process.env.EMAIL_VERIFY_POLL_MS || 10000);
/** When true, every discovered checkbox is checked (overrides keyword heuristics unless CONTACT_FORM_VALUES_JSON sets that name). */
const checkAllCheckboxes = /^1|true|yes$/i.test(String(process.env.CHECK_ALL_CHECKBOXES ?? '').trim());
/** When true, send SMTP email on any test failure (see sendFailureAlertEmail / ALERT_SMTP_* env vars). */
const alertEmailOnFailure = /^1|true|yes$/i.test(String(process.env.ALERT_EMAIL_ON_FAILURE ?? '').trim());

const playwrightClientVersion = cp
  .execSync('npx playwright --version')
  .toString()
  .trim()
  .split(' ')[1];

// =============================================================================
// Small utilities
// =============================================================================

/**
 * Default directory where Playwright stores downloaded browsers (local runs only).
 * @returns {string}
 */
function defaultMsPlaywrightCache() {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (local) return path.join(local, 'ms-playwright');
    return path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  }
  return path.join(os.homedir(), '.cache', 'ms-playwright');
}

if (!useLambdaTest) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = defaultMsPlaywrightCache();
}

/**
 * @param {string} name Environment variable name
 * @returns {string} Trimmed value
 * @throws If missing or blank
 */
function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required env: ${name}`);
  }
  return String(value).trim();
}

/**
 * Parses CONTACT_FORM_VALUES_JSON: explicit `input name` → string value overrides on top of heuristics.
 * @returns {Record<string, string>}
 */
function parseFormValueOverrides() {
  const raw = String(process.env.CONTACT_FORM_VALUES_JSON || '').trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
  } catch (e) {
    console.warn('CONTACT_FORM_VALUES_JSON is not valid JSON; ignoring.', e.message);
  }
  return {};
}

/**
 * When VERIFY_EMAIL is on, polls IMAP until a matching message appears or timeout.
 * Uses EMAIL_EXPECTED_SUBJECT (required when enabled) and optional EMAIL_EXPECTED_FROM.
 * Auth password: EMAIL_APP_PSWD if set, else IMAP_PASS (Gmail: use an app password).
 */
async function waitForEmailReceipt() {
  if (!verifyEmail) return;

  const imapHost = getRequiredEnv('IMAP_HOST');
  const imapPort = Number(process.env.IMAP_PORT || 993);
  const imapSecure = !/^0|false|no$/i.test(String(process.env.IMAP_SECURE ?? 'true').trim());
  const imapUser = getRequiredEnv('IMAP_USER');
  const imapPass = String(process.env.EMAIL_APP_PSWD || process.env.IMAP_PASS || '').trim();
  if (!imapPass) {
    throw new Error('Missing IMAP_PASS or EMAIL_APP_PSWD (Gmail requires an app password when 2FA is on).');
  }
  const imapMailbox = String(process.env.IMAP_MAILBOX || 'INBOX').trim();
  const expectedFrom = String(process.env.EMAIL_EXPECTED_FROM || '').trim().toLowerCase();
  const expectedSubject = getRequiredEnv('EMAIL_EXPECTED_SUBJECT').toLowerCase();
  const lookbackMinutes = Number(process.env.EMAIL_LOOKBACK_MINUTES || 10);

  const startedAt = Date.now();
  const sinceDate = new Date(Date.now() - lookbackMinutes * 60 * 1000);
  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapSecure,
    auth: { user: imapUser, pass: imapPass },
    logger: false,
  });

  console.log(
    `Email verification enabled. Polling ${imapMailbox} for up to ${Math.ceil(emailVerifyTimeoutMs / 1000)}s...`
  );

  try {
    await client.connect();
    await client.mailboxOpen(imapMailbox, { readOnly: true });

    while (Date.now() - startedAt < emailVerifyTimeoutMs) {
      const uids = await client.search({ since: sinceDate });
      const candidates = [];

      for (const uid of uids.slice(-20)) {
        const message = await client.fetchOne(uid, { envelope: true, internalDate: true });
        if (!message?.envelope) continue;

        const subject = (message.envelope.subject || '').toLowerCase();
        const fromAddress = (message.envelope.from?.[0]?.address || '').toLowerCase();
        const isSubjectMatch = subject.includes(expectedSubject);
        const isFromMatch = expectedFrom ? fromAddress.includes(expectedFrom) : true;

        if (isSubjectMatch && isFromMatch) {
          console.log(
            `Email received: subject="${message.envelope.subject || ''}" from="${fromAddress}" at ${message.internalDate}`
          );
          return;
        }

        candidates.push({
          subject: message.envelope.subject || '',
          from: fromAddress,
          at: message.internalDate,
        });
      }

      console.log(candidates.length ? 'Latest mailbox messages checked:' : 'No recent messages found yet.', candidates);
      await new Promise((r) => setTimeout(r, emailVerifyPollMs));
    }

    throw new Error(
      `Email not received within ${Math.ceil(emailVerifyTimeoutMs / 1000)}s. Expected subject to include "${expectedSubject}"${
        expectedFrom ? ` and from to include "${expectedFrom}"` : ''
      }.`
    );
  } finally {
    await client.logout().catch(() => {});
  }
}

/**
 * LambdaTest grid hook: no-op when running locally.
 * @param {import('playwright').Page} page
 * @param {{ action: string, arguments?: Record<string, unknown> }} payload
 */
async function lambdaTestStatus(page, payload) {
  if (!useLambdaTest) return;
  try {
    await page.evaluate(
      (_) => {},
      `lambdatest_action: ${JSON.stringify(payload)}`
    );
  } catch {
    /* ignore */
  }
}

/**
 * Launches local Chromium, or falls back to system Chrome if the bundled binary is missing.
 */
async function launchLocalBrowser() {
  const opts = { headless: headlessLocal };
  try {
    return await chromium.launch(opts);
  } catch (e) {
    if (!String(e.message || '').includes("Executable doesn't exist")) throw e;
    console.warn(
      'Bundled Chromium not found. Retrying with channel: chrome (install Google Chrome or run: npx playwright install chromium).'
    );
    return await chromium.launch({ ...opts, channel: 'chrome' });
  }
}

/**
 * Closes Playwright context and browser; errors are swallowed so `finally` always completes.
 * @param {import('playwright').BrowserContext} context
 * @param {import('playwright').Browser} browser
 */
async function closeBrowserWhenReady(context, browser) {
  console.log('Closing browser...');
  await context.close().catch(() => {});
  await browser.close().catch(() => {});
}

/**
 * Local headed runs: blocks on "Press Enter" so you can inspect the page (skipped without TTY or when CLOSE_BROWSER=1).
 */
async function pauseIfLocalHeadedKeepingBrowserOpen() {
  if (closeBrowserImmediately) return;
  if (!process.stdin.isTTY) {
    console.log('No interactive terminal; skipping wait-before-close.');
    return;
  }
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter to close the browser... ', () => {
      rl.close();
      resolve();
    });
  });
}

/**
 * Best-effort dismissal of cookie bars / consent buttons that intercept clicks.
 * @param {import('playwright').Page} page
 */
async function dismissOverlays(page) {
  const quick = { timeout: 2500 };
  const tryClick = async (loc) => {
    try {
      const l = typeof loc === 'string' ? page.locator(loc).first() : loc;
      await l.waitFor({ state: 'visible', timeout: 1200 });
      await l.click(quick);
      await new Promise((r) => setTimeout(r, 400));
    } catch {
      /* ignore */
    }
  };

  await tryClick(page.getByRole('button', { name: /^(accept|agree|allow|ok|got it|close)$/i }));
  await tryClick(page.getByRole('button', { name: /accept all|allow all|i agree/i }));
  await tryClick('.fusion-cookie-bar .fusion-button, .cookie-bar .accept, #cookie-law-info-accept');
}

// =============================================================================
// Contact Form 7 (CF7) helpers
// =============================================================================

/**
 * Locates the primary `form.wpcf7-form`: submit control plus at least one visible fillable field
 * (text-like input, textarea, or checkbox).
 * Prefers forms that include `first-name` when any candidate has it (avoids duplicate/decoy forms on some themes).
 * @param {import('playwright').Page} page
 * @returns {Promise<import('playwright').Locator>}
 */
async function resolveContactForm(page) {
  const formIndex = await page.evaluate(() => {
    const fillableInputType = (t) => {
      const x = (t || 'text').toLowerCase();
      return ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes(x);
    };
    const isUsableField = (el) => {
      if (!el.getAttribute('name')) return false;
      const r = el.getBoundingClientRect();
      const cs = window.getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      if (r.width <= 0 || r.height <= 0) return false;
      if (el.tagName === 'TEXTAREA') return true;
      if (el.tagName !== 'INPUT') return false;
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') return true;
      if (['hidden', 'submit', 'button', 'image', 'file', 'radio', 'range', 'color'].includes(type)) return false;
      return fillableInputType(el.type);
    };
    const hasVisibleFillable = (form) => {
      for (const el of form.querySelectorAll('input, textarea')) {
        if (isUsableField(el)) return true;
      }
      return false;
    };

    const allForms = [...document.querySelectorAll('form.wpcf7-form')];
    let candidates = allForms.filter((f) => f.querySelector('input.wpcf7-submit') && hasVisibleFillable(f));
    const withFirstName = candidates.filter((f) => f.querySelector('input[name="first-name"]'));
    if (withFirstName.length) candidates = withFirstName;

    let best = -1;
    let bestArea = -1;
    for (const f of candidates) {
      const inputs = [...f.querySelectorAll('input:not([type="hidden"]), textarea')].filter((input) =>
        isUsableField(input)
      );
      const formArea = inputs.reduce((sum, input) => {
        const r = input.getBoundingClientRect();
        return sum + Math.max(0, r.width) * Math.max(0, r.height);
      }, 0);
      if (formArea > bestArea) {
        bestArea = formArea;
        best = allForms.indexOf(f);
      }
    }
    return best;
  });

  if (formIndex < 0) {
    throw new Error('No usable form.wpcf7-form with submit + at least one visible fillable field (check page structure)');
  }

  const form = page.locator('form.wpcf7-form').nth(formIndex);
  await form.waitFor({ state: 'visible', timeout: 15000 });

  const fields = await collectFillableFields(form);
  const first = fields[0];
  if (first) await visibleFormControl(form, first).scrollIntoViewIfNeeded();
  return form;
}

/** @typedef {{ name: string, kind: 'textarea' | 'text' | 'checkbox' }} FillableField */

/**
 * Locator for the visible control for one discovered field (text-like input, textarea, or checkbox).
 * @param {import('playwright').Locator} form
 * @param {FillableField} field
 */
function visibleFormControl(form, field) {
  if (field.kind === 'checkbox') {
    return form.locator(`input[type="checkbox"][name="${field.name}"]`).filter({ visible: true }).first();
  }
  return form
    .locator(`textarea[name="${field.name}"], input[name="${field.name}"]:not([type="checkbox"]):not([type="radio"])`)
    .filter({ visible: true })
    .first();
}

/**
 * Sets a single field: text-like fields use click + `fill`; checkboxes use `setChecked` from string/boolean overrides.
 * @param {import('playwright').Locator} form
 * @param {FillableField} field
 * @param {string} value Raw or override string (`true`/`1`/`yes`/`on` = checked for checkboxes).
 */
async function fillCf7Control(form, field, value) {
  const locator = visibleFormControl(form, field);
  await locator.scrollIntoViewIfNeeded();
  if (field.kind === 'checkbox') {
    const checked = /^1|true|yes|on$/i.test(String(value).trim());
    await locator.setChecked(checked);
    return;
  }
  await locator.click({ timeout: 5000 });
  await locator.fill(value);
}

/**
 * Ordered unique fields: visible text-like `input`s, `textarea`s, and `checkbox` inputs with a `name` (DOM order).
 * @param {import('playwright').Locator} form
 * @returns {Promise<FillableField[]>}
 */
async function collectFillableFields(form) {
  return form.evaluate((formEl) => {
    const fillableInputType = (t) => {
      const x = (t || 'text').toLowerCase();
      return ['text', 'email', 'tel', 'url', 'number', 'search', ''].includes(x);
    };
    const skipNonCheckbox = new Set(['hidden', 'submit', 'button', 'image', 'file', 'radio', 'range', 'color']);
    const hiddenLike = (node) => {
      const r = node.getBoundingClientRect();
      const cs = window.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
      return r.width === 0 || r.height === 0;
    };

    /** @type {{ name: string, kind: 'textarea' | 'text' | 'checkbox' }[]} */
    const fields = [];
    const seen = new Set();
    for (const el of formEl.querySelectorAll('input, textarea')) {
      const name = el.getAttribute('name');
      if (!name || seen.has(name)) continue;

      if (el.tagName === 'TEXTAREA') {
        if (hiddenLike(el)) continue;
        seen.add(name);
        fields.push({ name, kind: 'textarea' });
        continue;
      }
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox') {
        if (hiddenLike(el)) continue;
        seen.add(name);
        fields.push({ name, kind: 'checkbox' });
        continue;
      }
      if (skipNonCheckbox.has(type) || !fillableInputType(el.type)) continue;
      if (hiddenLike(el)) continue;
      seen.add(name);
      fields.push({ name, kind: 'text' });
    }
    return fields;
  });
}

/**
 * Per-field metadata from the DOM (for heuristics). Uses the first layout-visible node per `name`.
 * @param {import('playwright').Locator} form
 * @param {FillableField[]} fields
 */
async function collectFieldMetas(form, fields) {
  return form.evaluate((formEl, fieldList) => {
    const visibleLike = (node) => {
      const r = node.getBoundingClientRect();
      const cs = window.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      return r.width > 0 && r.height > 0;
    };
    const metas = [];
    for (const f of fieldList) {
      const sel =
        f.kind === 'checkbox'
          ? `input[type="checkbox"][name="${CSS.escape(f.name)}"]`
          : `textarea[name="${CSS.escape(f.name)}"], input[name="${CSS.escape(f.name)}"]:not([type="checkbox"]):not([type="radio"])`;
      const nodes = [...formEl.querySelectorAll(sel)];
      const el = nodes.find(visibleLike) || nodes[0];
      if (!el) continue;
      metas.push({
        name: f.name,
        kind: f.kind,
        tag: el.tagName,
        type: el.tagName === 'INPUT' ? el.type || 'text' : 'textarea',
        id: el.id || '',
        placeholder: el.getAttribute('placeholder') || '',
      });
    }
    return metas;
  }, fields);
}

/**
 * Builds `name` → value string using `name` / `id` / `placeholder` / `type` / `kind`, then merges `overrides`.
 * Checkbox values: `"true"` / `"1"` / `"yes"` / `"on"` (case-insensitive) → checked; otherwise unchecked.
 * Set env `CHECK_ALL_CHECKBOXES=1` to check every checkbox (e.g. multi-line legal consent forms).
 * @param {Array<{ name: string, kind?: string, tag: string, type: string, id: string, placeholder: string }>} fieldMetas
 * @param {Record<string, string>} overrides
 * @returns {Record<string, string>}
 */
function buildContactFormValues(fieldMetas, overrides) {
  const haystack = (m) => [m.name, m.id, m.placeholder].filter(Boolean).join(' ').toLowerCase();

  const consentLike = (hay) =>
    /\b(consent|terms|accept|agree|acknowledge|privacy|newsletter|subscribe|gdpr|opt[\s-]?in|permission|voicemail|record(ing)?|debt collector|collect(ing)? a debt|inquiry|disclosure|fdcpa|mini miranda|electronic|e-?sign|signature)\b/.test(
      hay
    );

  const guess = (m) => {
    if (m.kind === 'checkbox' || (m.type || '').toLowerCase() === 'checkbox') {
      if (checkAllCheckboxes) return 'true';
      const hay = haystack(m);
      if (consentLike(hay)) return 'true';
      return 'false';
    }

    const hay = haystack(m);
    const t = (m.type || 'text').toLowerCase();

    if (t === 'email' || hay.includes('email')) return process.env.FORM_TEST_EMAIL || 'testuser@example.com';
    if (t === 'tel' || /\bphone\b|\btel\b|\bmobile\b/.test(hay)) return process.env.FORM_TEST_PHONE || '9999999999';
    if (hay.includes('subject')) return 'Test Subject';
    if (m.tag === 'TEXTAREA' || /\bmessage\b|\bcomment\b|\bhelp\b|\bbody\b|\bcontent\b|\bdetails\b/.test(hay)) {
      return 'Testing form submission';
    }
    if (/\bfirst[\s_-]*name\b|\bfirstname\b|\bfname\b/.test(hay) || (hay.includes('first') && hay.includes('name'))) {
      return 'Test';
    }
    if (/\blast[\s_-]*name\b|\blastname\b|\blname\b/.test(hay) || (hay.includes('last') && hay.includes('name'))) {
      return 'User';
    }
    if (/\bfull[\s_-]*name\b|\bfullname\b|\byour-name\b/.test(hay) || (hay.includes('full') && hay.includes('name'))) {
      return 'Test User';
    }
    if (hay.includes('company') || hay.includes('organization')) return 'Test Company';
    if (hay.includes('zip') || hay.includes('postal')) return '34986';
    return 'Test';
  };

  const out = {};
  for (const m of fieldMetas) {
    const o = overrides[m.name];
    out[m.name] = o !== undefined && o !== null ? String(o) : guess(m);
  }
  return out;
}

/**
 * Copies visible values onto same-name hidden duplicates (CF7 / Fusion). Handles text fields and checkboxes.
 * @param {import('playwright').Locator} form
 * @param {FillableField[]} fields
 */
async function syncHiddenInputsFromVisible(form, fields) {
  await form.evaluate((formEl, fieldList) => {
    const isHidden = (node) => {
      const r = node.getBoundingClientRect();
      const cs = window.getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
      return r.width === 0 || r.height === 0;
    };

    const visibleTextSource = (name) => {
      const nodes = [...formEl.querySelectorAll(`[name="${name}"]`)];
      return (
        nodes.find(
          (node) =>
            !isHidden(node) &&
            'value' in node &&
            node.type !== 'checkbox' &&
            node.type !== 'radio'
        ) || null
      );
    };

    fieldList.forEach(({ name, kind }) => {
      if (kind === 'checkbox') {
        const boxes = [...formEl.querySelectorAll(`input[type="checkbox"][name="${name}"]`)];
        const source = boxes.find((n) => !isHidden(n));
        if (!source) return;
        const checked = source.checked;
        boxes.forEach((el) => {
          if (el === source || !isHidden(el)) return;
          el.checked = checked;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        formEl.querySelectorAll(`input[type="hidden"][name="${name}"]`).forEach((el) => {
          if (!isHidden(el)) return;
          el.value = checked ? '1' : '';
          el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return;
      }

      const source = visibleTextSource(name);
      if (!source) return;
      const val = source.value;
      formEl.querySelectorAll(`[name="${name}"]`).forEach((el) => {
        if (!('value' in el) || el === source) return;
        if (!isHidden(el)) return;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    });
  }, fields);
}

/**
 * Re-fills every field in order (CF7/Fusion may wipe earlier fields when later ones change).
 * @param {import('playwright').Locator} form
 * @param {FillableField[]} fields
 * @param {Record<string, string>} valuesByName
 */
async function refillAllVisibleFields(form, fields, valuesByName) {
  for (const field of fields) {
    await fillCf7Control(form, field, valuesByName[field.name]);
  }
}

/**
 * Refills all fields, waits `pauseMs`, then syncs hidden duplicates.
 * @param {import('playwright').Locator} form
 * @param {FillableField[]} fields
 * @param {Record<string, string>} valuesByName
 * @param {number} pauseMs Pause after refill before syncing hidden inputs
 */
async function refillSyncCf7(form, fields, valuesByName, pauseMs) {
  await refillAllVisibleFields(form, fields, valuesByName);
  if (pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
  await syncHiddenInputsFromVisible(form, fields);
}

/**
 * Ensures non-AJAX form submits also carry `?lambdatest=1` as a GET parameter.
 * Also adds a hidden field for handlers that inspect submitted form values.
 * @param {import('playwright').Locator} form
 */
async function ensureLambdaTestFormSubmitMarker(form) {
  await form.evaluate((formEl) => {
    const withParam = (rawUrl) => {
      const url = new URL(rawUrl || window.location.href, window.location.href);
      url.searchParams.set('lambdatest', '1');
      return url.toString();
    };

    formEl.setAttribute('action', withParam(formEl.getAttribute('action')));

    let marker = formEl.querySelector('input[name="lambdatest"]');
    if (!marker) {
      marker = document.createElement('input');
      marker.type = 'hidden';
      marker.name = 'lambdatest';
      formEl.appendChild(marker);
    }
    marker.value = '1';
  });
}

/**
 * Contact Form 7 usually submits through XHR/fetch to a REST endpoint, so the
 * page URL alone is not enough for PHP code that checks `$_GET['lambdatest']`.
 * @param {import('playwright').BrowserContext} context
 */
async function installLambdaTestSubmitQueryParam(context) {
  await context.route(/\/wp-json\/contact-form-7\/|admin-ajax\.php|wpcf7/i, async (route) => {
    const request = route.request();
    if (request.method().toUpperCase() !== 'POST') {
      await route.continue();
      return;
    }

    const markedUrl = withLambdaTestQueryParam(request.url());
    await route.continue(markedUrl === request.url() ? undefined : { url: markedUrl });
  });
}

/**
 * Reads CF7 response text (Fusion theme exposes `.fusion-alert-content`; otherwise generic output).
 * @param {import('playwright').Page} page
 * @returns {Promise<string>}
 */
async function readCf7ResponseText(page) {
  const fusionAlert = page.locator('.wpcf7-response-output .fusion-alert-content');
  if ((await fusionAlert.count()) > 0) {
    return (await fusionAlert.first().textContent())?.trim() ?? '';
  }
  return (await page.locator('.wpcf7-response-output').textContent())?.trim() ?? '';
}

/**
 * Collects validation tips and invalid fields after a failed submit (browser context).
 * @returns {Promise<{ tips: string[], invalidFields: { name: string, message?: string }[], responseClasses: string, hasSent: boolean }>}
 */
async function gatherSubmitFailureDetails(page) {
  return page.evaluate(() => {
    const forms = [...document.querySelectorAll('form.wpcf7-form, .wpcf7-form')];
    const formEl = forms[forms.length - 1] || document.querySelector('.wpcf7-form');
    const tips = [...document.querySelectorAll('.wpcf7-not-valid-tip')].map((el) => (el.textContent || '').trim());
    const invalidFields = [...document.querySelectorAll('.wpcf7-form [aria-invalid="true"]')].map((el) => ({
      name: el.getAttribute('name') || el.id || el.className,
      message: el.closest('.wpcf7-form-control-wrap')?.querySelector('.wpcf7-not-valid-tip')?.textContent?.trim(),
    }));
    const responseClasses = document.querySelector('.wpcf7-response-output')?.className ?? '';
    return { tips, invalidFields, responseClasses, hasSent: formEl?.classList.contains('sent') ?? false };
  });
}

/**
 * @param {Awaited<ReturnType<typeof gatherSubmitFailureDetails>>} details
 * @returns {string} One-line summary for error messages / logs
 */
function formatSubmitFailureSummary(details) {
  const fieldErrors = details.invalidFields
    .filter((f) => f.message)
    .map((f) => `${f.name}: ${f.message}`)
    .join('; ');
  const tipErrors = [...new Set(details.tips)].filter(Boolean).join('; ');
  return [fieldErrors && `Field errors: ${fieldErrors}`, tipErrors && `Validation tips: ${tipErrors}`, `response classes: ${details.responseClasses}`]
    .filter(Boolean)
    .join(' | ');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Plain-text body for failure alert emails.
 * @param {{ url: string, error: string, responseText: string, details: Awaited<ReturnType<typeof gatherSubmitFailureDetails>> | null }} p
 */
function formatFailureAlertBody(p) {
  const lines = [
    `Page: ${p.url}`,
    `Time: ${new Date().toISOString()}`,
    '',
    'Error:',
    p.error,
    '',
  ];
  if (p.responseText) {
    lines.push('CF7 / Fusion response text:', p.responseText, '');
  }
  if (p.details) {
    const summary = formatSubmitFailureSummary(p.details);
    if (summary) {
      lines.push('Summary:', summary, '');
    }
    lines.push('Full validation payload (JSON):', JSON.stringify(p.details, null, 2));
  } else {
    lines.push('(No CF7 validation snapshot was available — page may have failed before response UI or selectors differ.)');
  }
  return lines.join('\n');
}

/**
 * Sends one SMTP message when ALERT_EMAIL_ON_FAILURE=1.
 * Required: ALERT_SMTP_HOST, ALERT_EMAIL_TO.
 * From: ALERT_EMAIL_FROM, or falls back to IMAP_USER.
 * Auth: ALERT_SMTP_USER + ALERT_SMTP_PASS, or user falls back to IMAP_USER and pass to
 * EMAIL_APP_PSWD, then IMAP_PASS (same Gmail app password as IMAP is fine).
 * Optional: ALERT_SMTP_PORT (default 587), ALERT_SMTP_SECURE (true for port 465).
 * @param {import('playwright').Page | null} page
 * @param {string} errorMessage
 */
async function sendFailureAlertEmail(page, errorMessage) {
  if (!alertEmailOnFailure) return;

  let responseText = '';
  /** @type {Awaited<ReturnType<typeof gatherSubmitFailureDetails>> | null} */
  let details = null;
  try {
    if (page && typeof page.isClosed === 'function' && !page.isClosed()) {
      [responseText, details] = await Promise.all([
        readCf7ResponseText(page).catch(() => ''),
        gatherSubmitFailureDetails(page).catch(() => null),
      ]);
    }
  } catch {
    /* ignore snapshot errors */
  }

  const text = formatFailureAlertBody({
    url: CONTACT_PAGE_URL,
    error: errorMessage,
    responseText,
    details,
  });

  let host;
  let to;
  try {
    host = getRequiredEnv('ALERT_SMTP_HOST');
    to = getRequiredEnv('ALERT_EMAIL_TO');
  } catch (err) {
    console.warn('Failure alert email skipped (missing env):', err.message);
    return;
  }

  const from = String(process.env.ALERT_EMAIL_FROM || process.env.IMAP_USER || '').trim();
  if (!from) {
    console.warn('Failure alert email skipped (set ALERT_EMAIL_FROM or IMAP_USER).');
    return;
  }

  const smtpUser = String(process.env.ALERT_SMTP_USER || process.env.IMAP_USER || '').trim();
  const smtpPass = String(
    process.env.ALERT_SMTP_PASS || process.env.EMAIL_APP_PSWD || process.env.IMAP_PASS || ''
  ).trim();

  if (smtpUser && !smtpPass) {
    console.warn(
      'Failure alert email skipped (set ALERT_SMTP_PASS, or reuse EMAIL_APP_PSWD / IMAP_PASS for the SMTP user).'
    );
    return;
  }

  const port = Number(process.env.ALERT_SMTP_PORT || 587);
  const secure = /^1|true|yes$/i.test(String(process.env.ALERT_SMTP_SECURE ?? '').trim());

  let hostname = CONTACT_PAGE_URL;
  try {
    hostname = new URL(CONTACT_PAGE_URL).hostname;
  } catch {
    /* keep full url */
  }

  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: smtpUser ? { user: smtpUser, pass: smtpPass } : undefined,
    });
    await transporter.sendMail({
      from,
      to,
      subject: `[Contact form test FAILED] ${hostname}`,
      text,
      html: `<pre style="font-family:ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
    });
    console.log('Failure alert email sent to:', to);
  } catch (err) {
    console.warn('Failure alert email could not be sent:', err.message);
  }
}

function logStartupMode() {
  console.log('Starting Playwright test...');
  console.log('Playwright version:', playwrightClientVersion);
  if (useLambdaTest) {
    console.log('Mode: LambdaTest');
  } else if (headlessLocal) {
    console.log('Mode: local Chromium (headless). Unset HEADLESS to see the browser.');
  } else if (closeBrowserImmediately) {
    console.log('Mode: local Chromium (headed). CLOSE_BROWSER=1 — browser closes when the test finishes.');
  } else {
    console.log(
      'Mode: local Chromium (headed). Press Enter in this terminal to close the browser (set CLOSE_BROWSER=1 to skip).'
    );
  }
}

// =============================================================================
// Main
// =============================================================================

(async () => {
  logStartupMode();

  const outputJsonResult = /^1|true|yes$/i.test(String(process.env.OUTPUT_JSON_RESULT ?? '').trim());
  /** @type {any} */
  let apiResult = null;
  let preSubmitSnapshot = null;
  let responseTextSnapshot = '';

  const capabilities = {
    browserName: 'Chrome',
    browserVersion: '147.0',
    'LT:Options': {
      user: process.env.LT_USERNAME,
      accessKey: process.env.LT_ACCESS_KEY,
      geoLocation: 'IN',
      timezone: 'Kolkata',
      video: true,
      platform: 'Windows 10',
      network: true,
      build: 'ContactFormTest',
      name: 'AdamParks Contact Form',
      tunnel: false,
      console: true,
    },
  };

  const browser = useLambdaTest
    ? await chromium.connect({
        wsEndpoint: `wss://cdp.lambdatest.com/playwright?capabilities=${encodeURIComponent(JSON.stringify(capabilities))}`,
      })
    : await launchLocalBrowser();

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await installLambdaTestSubmitQueryParam(context);
  const page = await context.newPage();

  try {
    console.log('Opening Contact Page:', CONTACT_PAGE_URL);
    await page.goto(CONTACT_PAGE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
    await dismissOverlays(page);

    console.log('Filling Contact Form...');
    const form = await resolveContactForm(page);
    await ensureLambdaTestFormSubmitMarker(form);

    const fieldDescriptors = await collectFillableFields(form);
    if (!fieldDescriptors.length) {
      throw new Error('No visible fillable fields (text inputs, textareas, or checkboxes with a name) found in the form');
    }

    const valueOverrides = parseFormValueOverrides();
    const fieldMetas = await collectFieldMetas(form, fieldDescriptors);
    const contactFormValues = buildContactFormValues(fieldMetas, valueOverrides);
    const checkboxFields = fieldDescriptors.filter((f) => f.kind === 'checkbox');
    if (checkboxFields.length) {
      console.log(
        'Checkboxes (name → will check):',
        Object.fromEntries(checkboxFields.map((f) => [f.name, contactFormValues[f.name]]))
      );
    }

    for (const field of fieldDescriptors) {
      await fillCf7Control(form, field, contactFormValues[field.name]);
    }

    await refillSyncCf7(form, fieldDescriptors, contactFormValues, 200);

    // CF7/Fusion often clears *visible* inputs right after applying/validating,
    // but keeps the submitted values in hidden duplicates. So for API/debugging,
    // snapshot the value from any input/textarea with the same `name`, preferring
    // non-empty values (and for checkboxes, prefer checked state).
    const preSubmit = await form.evaluate((formEl, fields) => {
      const isHidden = (node) => {
        const r = node.getBoundingClientRect();
        const cs = window.getComputedStyle(node);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return true;
        return r.width === 0 || r.height === 0;
      };

      const getTextValue = (name) => {
        const nodes = [
          ...formEl.querySelectorAll(`input[name="${CSS.escape(name)}"]`),
          ...formEl.querySelectorAll(`textarea[name="${CSS.escape(name)}"]`),
        ];
        // Prefer any non-empty value (hidden duplicates survive even if visible cleared).
        for (const n of nodes) {
          if (!('value' in n)) continue;
          if (String(n.value || '').trim().length) return String(n.value);
        }
        // Otherwise return first value we find (could be empty string).
        const first = nodes.find((n) => 'value' in n);
        return first && 'value' in first ? String(first.value || '') : '';
      };

      const getCheckboxValue = (name) => {
        // Prefer actual checkbox checked state.
        const boxes = [...formEl.querySelectorAll(`input[type="checkbox"][name="${CSS.escape(name)}"]`)];
        const box = boxes.find((b) => !isHidden(b)) || boxes[0];
        if (box && 'checked' in box) return box.checked ? 'true' : 'false';

        // Fallback to hidden mirror inputs: CF7 often uses type="hidden" named the same.
        const hidden = formEl.querySelector(`input[type="hidden"][name="${CSS.escape(name)}"]`);
        if (hidden && 'value' in hidden) return String(hidden.value || '').trim() === '1' ? 'true' : 'false';
        return 'false';
      };

      const out = {};
      for (const f of fields) {
        if (f.kind === 'checkbox') out[f.name] = getCheckboxValue(f.name);
        else out[f.name] = getTextValue(f.name);
      }
      return out;
    }, fieldDescriptors);
    preSubmitSnapshot = preSubmit;
    console.log('Field values before submit (submitted snapshot):', preSubmit);

    console.log('Submitting form...');
    await new Promise((r) => setTimeout(r, 300));
    await refillSyncCf7(form, fieldDescriptors, contactFormValues, 0);

    const submit = form.locator('input.wpcf7-submit').filter({ visible: true }).first();
    await submit.scrollIntoViewIfNeeded();
    await submit.click();

    console.log('Waiting for response...');
    await page.waitForSelector('.wpcf7-response-output', { timeout: 20000 });
    const responseText = await readCf7ResponseText(page);
    responseTextSnapshot = responseText;
    console.log('Response:', responseText);

    if (responseText && responseText.toLowerCase().includes('thank')) {
      console.log('Test PASSED!');
      let emailVerified = false;
      await waitForEmailReceipt();
      emailVerified = verifyEmail ? true : false;

      apiResult = {
        ok: true,
        url: CONTACT_PAGE_URL,
        responseText,
        preSubmit,
        emailVerification: {
          enabled: verifyEmail,
          verified: emailVerified,
        },
      };

      if (outputJsonResult) {
        console.log('RESULT_JSON:' + JSON.stringify(apiResult));
      }

      await lambdaTestStatus(page, {
        action: 'setTestStatus',
        arguments: { status: 'passed', remark: verifyEmail ? 'Form + email verification passed' : 'Form submitted successfully' },
      });
    } else {
      const details = await gatherSubmitFailureDetails(page);
      const diagnostic = formatSubmitFailureSummary(details);
      console.log('CF7 validation details:', JSON.stringify(details, null, 2));
      if (diagnostic) console.log('Summary:', diagnostic);

      apiResult = {
        ok: false,
        url: CONTACT_PAGE_URL,
        responseText,
        preSubmit: preSubmitSnapshot,
        error: 'Form submission did not return thank-you response',
        details,
        summary: diagnostic,
      };

      if (outputJsonResult) {
        console.log('RESULT_JSON:' + JSON.stringify(apiResult));
      }

      throw new Error(
        diagnostic
          ? `Form submission failed — ${responseText}. ${diagnostic}`
          : `Form submission failed or no success message — ${responseText}`
      );
    }
  } catch (e) {
    console.log('Test FAILED:', e.message);

    if (!apiResult) {
      // Best-effort: try to capture response + validation errors for API consumers.
      try {
        responseTextSnapshot = responseTextSnapshot || (await readCf7ResponseText(page).catch(() => ''));
      } catch {
        /* ignore */
      }
      let details = null;
      try {
        details = await gatherSubmitFailureDetails(page);
      } catch {
        /* ignore */
      }
      const diagnostic = details ? formatSubmitFailureSummary(details) : '';
      apiResult = {
        ok: false,
        url: CONTACT_PAGE_URL,
        responseText: responseTextSnapshot,
        preSubmit: preSubmitSnapshot,
        error: e.message,
        details,
        summary: diagnostic || undefined,
      };
    }

    if (outputJsonResult) {
      console.log('RESULT_JSON:' + JSON.stringify(apiResult));
    }

    await sendFailureAlertEmail(page, e.message);
    await lambdaTestStatus(page, { action: 'setTestStatus', arguments: { status: 'failed', remark: e.message } });
    throw e;
  } finally {
    await pauseIfLocalHeadedKeepingBrowserOpen();
    await closeBrowserWhenReady(context, browser);
  }
})().catch((err) => {
  console.error('Unexpected error:', err);
  if (/^1|true|yes$/i.test(String(process.env.OUTPUT_JSON_RESULT ?? '').trim())) {
    console.log('RESULT_JSON:' + JSON.stringify({ ok: false, url: CONTACT_PAGE_URL, error: err.message }));
  }
  process.exit(1);
});
