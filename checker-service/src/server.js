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

  const submitButton = loginScope ? await firstVisibleWithin(loginScope, submitSelectors) : null;
  if (submitButton) {
    await submitButton.click({ timeout: 5000 });
    await waitAfterLoginSubmit(page);
    return "button";
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
    return "form";
  }

  await passwordField.press("Enter");
  await waitAfterLoginSubmit(page);
  return "enter";
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

  await submitLoginForm(page, passwordField, loginScope);
}

async function visitLikelyStatusPages(page) {
  const candidates = [
    'a:has-text("Author Center")',
    'a:has-text("Author Dashboard")',
    'a:has-text("Submitted Manuscripts")',
    'a:has-text("Manuscripts with Decisions")',
    'a:has-text("Manuscripts in Review")',
    'a:has-text("Awaiting Revision")',
  ];

  const snapshots = [];
  snapshots.push(await collectPageText(page));

  for (const selector of candidates) {
    const link = page.locator(selector).first();
    try {
      if ((await link.count()) === 0 || !(await link.isVisible({ timeout: 1000 }))) continue;
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => null),
        link.click({ timeout: 5000 }),
      ]);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => null);
      snapshots.push(await collectPageText(page));
    } catch {
      // ScholarOne pages vary by journal; continue with other likely links.
    }
  }

  return snapshots.join("\n\n");
}

async function collectPageText(page) {
  return page.evaluate(() => {
    const removable = document.querySelectorAll("script, style, noscript, svg");
    removable.forEach((node) => node.remove());
    return document.body?.innerText || "";
  });
}

function normalizeLine(line) {
  return line.replace(/\s+/g, " ").trim();
}

function extractStatus(text) {
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

async function checkSubmission(input) {
  const browser = await chromium.launch({
    headless,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
    ],
  });

  try {
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
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    await page.goto(input.manuscriptUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);
    await waitForBotChallenge(page);

    await clickIfVisible(page, [
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'a:has-text("Accept")',
      'a:has-text("I Agree")',
    ]);

    await fillLoginForm(page, input);

    if (await stillOnLoginPage(page)) {
      const excerpt = normalizeLine(await pageText(page)).slice(0, 700);
      throw new Error(
        `ScholarOne login did not complete. Please verify the User ID and password, or check whether ScholarOne requires a manual login step. Page excerpt: ${excerpt}`
      );
    }

    const text = await visitLikelyStatusPages(page);
    const status = extractStatus(text);

    return {
      status,
      detail: `Detected on ${new URL(input.manuscriptUrl).hostname}`,
      rawExcerpt: normalizeLine(text).slice(0, 1000),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await browser.close();
  }
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

app.listen(port, () => {
  console.log(`IEEE checker service listening on ${port}`);
});
