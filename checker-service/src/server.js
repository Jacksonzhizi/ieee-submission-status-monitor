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

async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
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

async function clickIfVisible(page, selectors) {
  const locator = await firstVisible(page, selectors);
  if (!locator) return false;
  await locator.click({ timeout: 5000 });
  return true;
}

async function fillLoginForm(page, input) {
  const usernameField = await firstVisible(page, [
    'input[name="USERID"]',
    'input[name="UserID"]',
    'input[name="username"]',
    'input[id*="USER" i]',
    'input[id*="user" i]',
    'input[type="email"]',
    'input[type="text"]',
  ]);

  const passwordField = await firstVisible(page, [
    'input[name="PASSWORD"]',
    'input[name="Password"]',
    'input[name="password"]',
    'input[id*="PASS" i]',
    'input[id*="pass" i]',
    'input[type="password"]',
  ]);

  if (!usernameField || !passwordField) {
    throw new Error("Could not find ScholarOne login fields.");
  }

  await usernameField.fill(input.username);
  await passwordField.fill(input.password);

  const clicked = await clickIfVisible(page, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log In")',
    'button:has-text("Login")',
    'button:has-text("Sign In")',
    'a:has-text("Log In")',
    'a:has-text("Login")',
  ]);

  if (!clicked) {
    await passwordField.press("Enter");
  }
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
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: { width: 1440, height: 1100 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    await page.goto(input.manuscriptUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

    await clickIfVisible(page, [
      'button:has-text("Accept")',
      'button:has-text("I Agree")',
      'a:has-text("Accept")',
      'a:has-text("I Agree")',
    ]);

    await fillLoginForm(page, input);
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => null);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => null);

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
