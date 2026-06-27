import express from "express";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "64kb" }));

const port = Number(process.env.PORT || 3000);
const checkerToken = process.env.CHECKER_TOKEN || "";
const allowedHosts = (process.env.ALLOWED_HOSTS || "mc.manuscriptcentral.com")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter(Boolean);
const maxCheckMs = Number(process.env.MAX_CHECK_MS || 90000);
const headless = process.env.HEADLESS !== "false";
const challengeWaitMs = Number(process.env.CHALLENGE_WAIT_MS || 30000);

const STATUS_PATTERNS = [
  /\bawaiting\s+recommendation\b/i,
  /\bawaiting\b[^\n\r]{0,120}/i,
  /\bunder review\b[^\n\r]{0,80}/i,
  /\bwith (?:editor|administrator|reviewer)s?\b[^\n\r]{0,80}/i,
  /\breviewers? assigned\b[^\n\r]{0,80}/i,
  /\brequired reviews? completed\b[^\n\r]{0,80}/i,
  /\bdecision\b[^\n\r]{0,100}/i,
  /\bminor revision\b[^\n\r]{0,80}/i,
  /\bmajor revision\b[^\n\r]{0,80}/i,
  /\baccept(?:ed)?\b[^\n\r]{0,80}/i,
  /\breject(?:ed)?\b[^\n\r]{0,80}/i,
];

function requireAuth(request, response, next) {
  if (!checkerToken) return next();

  const authorization = request.get("authorization") || "";
  if (authorization !== `Bearer ${checkerToken}`) {
    return response.status(401).json({ error: "Unauthorized checker request." });
  }

  return next();
}

function validateInput(body) {
  const input = body && typeof body === "object" ? body : {};
  const journalName = String(input.journalName || "").trim();
  const manuscriptUrl = String(input.manuscriptUrl || "").trim();
  const username = String(input.username || "").trim();
  const password = String(input.password || "");

  if (!journalName) throw new Error("journalName is required.");
  if (!manuscriptUrl) throw new Error("manuscriptUrl is required.");
  if (!username) throw new Error("username is required.");
  if (!password) throw new Error("password is required.");

  let url;
  try {
    url = new URL(manuscriptUrl);
  } catch {
    throw new Error("manuscriptUrl must be a valid URL.");
  }

  const host = url.hostname.toLowerCase();
  const allowed = allowedHosts.some((allowedHost) => host === allowedHost || host.endsWith(`.${allowedHost}`));
  if (!allowed) {
    throw new Error(`Host ${host} is not allowed by ALLOWED_HOSTS.`);
  }

  return { journalName, manuscriptUrl: url.toString(), username, password };
}

function isBotChallengeText(text) {
  return /just a moment|verify you are human|checking your browser|challenge-error-text|cloudflare/i.test(text);
}

async function pageText(page) {
  try {
    return await page.locator("body").innerText({ timeout: 5000 });
  } catch {
    return "";
  }
}

async function waitForBotChallenge(page) {
  const started = Date.now();

  while (Date.now() - started < challengeWaitMs) {
    const text = await pageText(page);
    if (!isBotChallengeText(text)) return;
    await page.waitForTimeout(2500);
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => null);
  }

  const excerpt = normalizeLine(await pageText(page)).slice(0, 500);
  throw new Error(
    `ScholarOne blocked the automated browser with a Cloudflare challenge. Page excerpt: ${excerpt}`
  );
}

async function firstVisibleInFrame(frame, selectors) {
  for (const selector of selectors) {
    const locator = frame.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1500 }))) {
        return locator;
      }
    } catch {
      // Keep trying the next selector.
    }
  }

  return null;
}

async function firstVisible(page, selectors) {
  const pageLocator = await firstVisibleInFrame(page, selectors);
  if (pageLocator) return pageLocator;

  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const frameLocator = await firstVisibleInFrame(frame, selectors);
    if (frameLocator) return frameLocator;
  }

  return null;
}

async function clickIfVisible(page, selectors) {
  const locator = await firstVisible(page, selectors);
  if (!locator) return false;
  await locator.click({ timeout: 5000 });
  return true;
}

async function clickAndFollow(page, locator) {
  const context = page.context();
  const popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);

  await locator.click({ timeout: 5000 });

  const popup = await popupPromise;
  const target = popup || page;
  await target.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null);
  await target.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
  await target.waitForTimeout(1000);
  return bestContentPage(context, target);
}

async function firstVisibleWithin(root, selectors) {
  for (const selector of selectors) {
    const locator = root.locator(selector).first();
    try {
      if ((await locator.count()) > 0 && (await locator.isVisible({ timeout: 1000 }))) {
        return locator;
      }
    } catch {
      // Keep trying the next selector.
    }
  }

  return null;
}

async function loginScopeForPassword(passwordField) {
  const scopes = [
    passwordField.locator("xpath=ancestor::form[1]"),
    passwordField.locator("xpath=ancestor::*[contains(@class, 'login')][1]"),
    passwordField.locator("xpath=ancestor::*[contains(@id, 'login')][1]"),
    passwordField.locator("xpath=ancestor::table[1]"),
    passwordField.locator("xpath=ancestor::div[1]"),
  ];

  for (const scope of scopes) {
    try {
      if ((await scope.count()) > 0) return scope.first();
    } catch {
      // Keep trying broader scopes.
    }
  }

  return null;
}

async function stillOnLoginPage(page) {
  const hasPassword = await firstVisible(page, ['input[type="password"]']);
  if (hasPassword) return true;

  const text = normalizeLine(await pageText(page));
  return /Log In|Reset Password|Create An Account|User ID/i.test(text) && !/Author Center|Submitted Manuscripts/i.test(text);
}

async function waitAfterLoginSubmit(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => null);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(2500);
}

async function submitLoginForm(page, passwordField, loginScope) {
  const submitSelectors = [
    "#logInButton",
    "a#logInButton",
    '[id="logInButton"]',
    'a:has-text("Log In")',
    'button[type="submit"]',
    'input[type="submit"]',
    'input[type="image"]',
    'input[type="button"][value*="Log" i]',
    'input[type="button"][value*="Sign" i]',
    'input[value*="Log In" i]',
    'input[value*="Login" i]',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
  ];

  const submitButton =
    (loginScope ? await firstVisibleWithin(loginScope, submitSelectors) : null) ||
    (await firstVisible(page, submitSelectors));
  if (submitButton) {
    const targetPage = await clickAndFollow(page, submitButton);
    await waitAfterLoginSubmit(targetPage);
    return targetPage;
  }

  const submitted = await passwordField.evaluate((element) => {
    const input = element;
    const form = input.form || input.closest("form");
    if (!form) return false;

    if (typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return true;
    }

    const event = new Event("submit", { bubbles: true, cancelable: true });
    const allowed = form.dispatchEvent(event);
    if (allowed && typeof form.submit === "function") form.submit();
    return true;
  });

  if (submitted) {
    await waitAfterLoginSubmit(page);
    return bestContentPage(page.context(), page);
  }

  await passwordField.press("Enter");
  await waitAfterLoginSubmit(page);
  return bestContentPage(page.context(), page);
}

async function fillLoginForm(page, input) {
  await waitForBotChallenge(page);

  const passwordField = await firstVisible(page, [
    'input[name="PASSWORD"]',
    'input[name="Password"]',
    'input[name="password"]',
    'input[name*="pass" i]',
    'input[id*="PASS" i]',
    'input[id*="pass" i]',
    'input[autocomplete="current-password"]',
    'input[type="password"]',
  ]);

  const loginScope = passwordField ? await loginScopeForPassword(passwordField) : null;
  const usernameSelectors = [
    'input[name="USERID"]',
    'input[name="UserID"]',
    'input[name="login"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name*="user" i]',
    'input[name*="email" i]',
    'input[id*="login" i]',
    'input[id*="USER" i]',
    'input[id*="user" i]',
    'input[id*="email" i]',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[type="text"]',
  ];
  const usernameField =
    (loginScope ? await firstVisibleWithin(loginScope, usernameSelectors) : null) ||
    (await firstVisible(page, usernameSelectors));

  if (!usernameField || !passwordField) {
    const excerpt = normalizeLine(await pageText(page)).slice(0, 500);
    throw new Error(`Could not find ScholarOne login fields. Page excerpt: ${excerpt}`);
  }

  await usernameField.fill(input.username);
  await passwordField.fill(input.password);

  return submitLoginForm(page, passwordField, loginScope);
}

async function bestContentPage(context, preferredPage = null) {
  let best = preferredPage || context.pages()[0];
  let bestScore = -1;

  for (const openPage of context.pages()) {
    const url = openPage.url();
    const text = normalizeLine(await collectPageText(openPage));
    const isBrowserError = /^chrome-error:|^about:blank$/i.test(url);
    const score = (isBrowserError ? -10000 : 0) + text.length;

    if (score > bestScore) {
      best = openPage;
      bestScore = score;
    }
  }

  return best || preferredPage;
}

async function visitLikelyStatusPages(page) {
  const candidates = [
    '#navAuthorCenter',
    '#author',
    '#Author',
    '[id*="author" i]',
    'a:has-text("Author")',
    'button:has-text("Author")',
    'a:has-text("Author Center")',
    'a:has-text("Author Dashboard")',
    'a:has-text("Submitted Manuscripts")',
    'a:has-text("Manuscripts with Decisions")',
    'a:has-text("Manuscripts in Review")',
    'a:has-text("Awaiting Revision")',
  ];

  let currentPage = page;
  const snapshots = [];
  snapshots.push(await collectAllOpenPageText(page.context()));

  for (const selector of candidates) {
    const link = await firstVisible(currentPage, [selector]);
    try {
      if (!link) continue;
      currentPage = await clickAndFollow(currentPage, link);
      snapshots.push(await collectAllOpenPageText(currentPage.context()));
    } catch {
      // ScholarOne pages vary by journal; continue with other likely links.
    }
  }

  return snapshots.join("\n\n");
}

async function collectPageText(page) {
  const texts = [];

  for (const frame of page.frames()) {
    try {
      const text = await frame.locator("body").innerText({ timeout: 3000 });
      if (normalizeLine(text)) texts.push(text);
    } catch {
      try {
        const text = await frame.evaluate(() => document.body?.innerText || "");
        if (normalizeLine(text)) texts.push(text);
      } catch {
        // Ignore frames that cannot be inspected.
      }
    }
  }

  if (texts.length > 0) return texts.join("\n\n");

  try {
    const html = await page.content();
    return html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");
  } catch {
    return "";
  }
}

async function collectAllOpenPageText(context) {
  const texts = [];

  for (const openPage of context.pages()) {
    const text = await collectPageText(openPage);
    if (normalizeLine(text)) texts.push(text);
  }

  return texts.join("\n\n");
}

function normalizeLine(line) {
  return line.replace(/\s+/g, " ").trim();
}

function extractStatusPhrase(text) {
  const compact = normalizeLine(text);
  const phrasePatterns = [
    /\bAwaiting\s+Recommendation\b/i,
    /\bAwaiting\s+Reviewer\s+Scores\b/i,
    /\bAwaiting\s+Reviewer\s+Assignment\b/i,
    /\bAwaiting\s+Admin\s+Processing\b/i,
    /\bAwaiting\s+AE\s+Recommendation\b/i,
    /\bAwaiting\s+EIC\s+Decision\b/i,
    /\bRequired\s+Reviews\s+Completed\b/i,
    /\bUnder\s+Review\b/i,
    /\bWith\s+(?:Editor|Administrator|Reviewers?|Associate\s+Editor)\b/i,
    /\b(?:Minor|Major)\s+Revision\b/i,
    /\b(?:Accepted|Rejected)\b/i,
  ];

  for (const pattern of phrasePatterns) {
    const match = compact.match(pattern);
    if (match?.[0]) return normalizeLine(match[0]);
  }

  return null;
}

function extractStatus(text) {
  const phraseStatus = extractStatusPhrase(text);
  if (phraseStatus) return phraseStatus;

  const lines = text
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((line) => line.length >= 4 && line.length <= 220);

  const statusLabelLine = lines.find((line) => /status/i.test(line) && STATUS_PATTERNS.some((pattern) => pattern.test(line)));
  if (statusLabelLine) return statusLabelLine;

  for (const pattern of STATUS_PATTERNS) {
    const line = lines.find((candidate) => pattern.test(candidate));
    if (line) return line;
  }

  const compact = normalizeLine(text).slice(0, 1000);
  throw new Error(`Could not identify manuscript status. Page excerpt: ${compact}`);
}

async function launchBrowser() {
  const browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  const context = await browser.newContext({
    locale: "en-US",
    viewport: { width: 1440, height: 1100 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  return { browser, context };
}

async function summarizeContext(context) {
  const pages = [];

  for (const openPage of context.pages()) {
    const frames = [];
    for (const frame of openPage.frames()) {
      let text = "";
      let htmlSample = "";
      let links = [];
      let inputs = [];
      try {
        text = normalizeLine(await frame.locator("body").innerText({ timeout: 2000 })).slice(0, 1200);
      } catch {
        // Leave empty.
      }
      if (!text) {
        try {
          htmlSample = normalizeLine((await frame.content()).slice(0, 1200));
        } catch {
          // Leave empty.
        }
      }
      try {
        links = await frame.evaluate(() =>
          Array.from(document.querySelectorAll("a, button, input[type='submit'], input[type='button']"))
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              text:
                element.innerText ||
                element.getAttribute("value") ||
                element.getAttribute("title") ||
                element.getAttribute("aria-label") ||
                "",
              href: element.getAttribute("href") || "",
              id: element.id || "",
              name: element.getAttribute("name") || "",
            }))
            .filter((item) => item.text || item.href || item.id || item.name)
            .slice(0, 60)
        );
      } catch {
        // Ignore inaccessible frames.
      }
      try {
        inputs = await frame.evaluate(() =>
          Array.from(document.querySelectorAll("input, select, textarea"))
            .map((element) => ({
              tag: element.tagName.toLowerCase(),
              type: element.getAttribute("type") || "",
              id: element.id || "",
              name: element.getAttribute("name") || "",
              autocomplete: element.getAttribute("autocomplete") || "",
              placeholder: element.getAttribute("placeholder") || "",
            }))
            .slice(0, 60)
        );
      } catch {
        // Ignore inaccessible frames.
      }
      frames.push({
        url: frame.url(),
        text,
        htmlSample,
        links,
        inputs,
      });
    }

    pages.push({
      url: openPage.url(),
      title: await openPage.title().catch(() => ""),
      frames,
    });
  }

  return pages;
}

async function runSubmissionFlow(input, { debug = false } = {}) {
  const { browser, context } = await launchBrowser();
  const snapshots = [];

  try {
    let page = await context.newPage();
    page.setDefaultTimeout(15000);

    await page.goto(input.manuscriptUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
    await waitForBotChallenge(page);
    if (debug) snapshots.push({ stage: "opened", pages: await summarizeContext(context) });

    await clickIfVisible(page, [
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'a:has-text("Accept")',
      'a:has-text("I Agree")',
    ]);

    page = await fillLoginForm(page, input);
    page = await bestContentPage(context, page);
    if (debug) snapshots.push({ stage: "after-login", pages: await summarizeContext(context) });

    if (await stillOnLoginPage(page)) {
      const excerpt = normalizeLine(await pageText(page)).slice(0, 700);
      throw new Error(
        `ScholarOne login did not complete. Please verify the User ID and password, or check whether ScholarOne requires a manual login step. Page excerpt: ${excerpt}`
      );
    }

    const text = await visitLikelyStatusPages(page);
    if (debug) snapshots.push({ stage: "after-author-navigation", pages: await summarizeContext(context) });
    const status = extractStatus(text);

    const result = {
      status,
      detail: `Detected on ${new URL(input.manuscriptUrl).hostname}`,
      rawExcerpt: normalizeLine(text).slice(0, 1000),
      checkedAt: new Date().toISOString(),
    };
    if (debug) result.debug = snapshots;
    return result;
  } catch (error) {
    if (debug) {
      snapshots.push({ stage: "error", pages: await summarizeContext(context).catch(() => []) });
      return {
        ok: false,
        error: error instanceof Error ? error.message : "Checker failed.",
        debug: snapshots,
      };
    }

    throw error;
  } finally {
    await browser.close();
  }
}

async function checkSubmission(input) {
  return runSubmissionFlow(input);
}

function withTimeout(promise, milliseconds) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Check timed out after ${milliseconds} ms.`)), milliseconds);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.get("/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/check", requireAuth, async (request, response) => {
  try {
    const input = validateInput(request.body);
    const result = await withTimeout(checkSubmission(input), maxCheckMs);
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Checker failed.";
    response.status(500).json({ error: message });
  }
});

app.post("/debug-check", requireAuth, async (request, response) => {
  try {
    const input = validateInput(request.body);
    const result = await withTimeout(runSubmissionFlow(input, { debug: true }), maxCheckMs);
    response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Checker failed.";
    response.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`IEEE checker service listening on ${port}`);
});
