import { decryptPassword, encryptPassword } from "./crypto";
import { sendStatusChangeEmail } from "./email";
import { resolveJournal } from "./journal";
import { checkSubmissionStatus } from "./checker";
import type { MonitorRecord, RuntimeEnv, StatusEventRecord } from "./types";

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function detailWithSource(detail: string | undefined, source: string) {
  const suffix = detail?.trim() || "检测完成";
  return `${source}：${suffix}`;
}

function requireDb(env: RuntimeEnv) {
  if (!env.DB) throw new Error("D1 数据库未绑定。请在 .openai/hosting.json 中保持 d1 为 DB。");
  return env.DB;
}

function requireSecret(env: RuntimeEnv) {
  if (!env.APP_SECRET) {
    throw new Error("缺少 APP_SECRET，无法加密保存投稿平台密码。");
  }
  return env.APP_SECRET;
}

export async function ensureSchema(env: RuntimeEnv) {
  const db = requireDb(env);
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS monitors (id text PRIMARY KEY NOT NULL, journal_name text NOT NULL, journal_slug text NOT NULL, manuscript_url text NOT NULL, username text NOT NULL, password_ciphertext text NOT NULL, password_iv text NOT NULL, password_salt text NOT NULL, notify_email text NOT NULL, last_status text, last_status_detail text, last_checked_at text, last_changed_at text, check_count integer DEFAULT 0 NOT NULL, enabled integer DEFAULT 1 NOT NULL, created_at text NOT NULL, updated_at text NOT NULL)"
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS status_events (id text PRIMARY KEY NOT NULL, monitor_id text NOT NULL, previous_status text, current_status text NOT NULL, detail text, raw_excerpt text, checked_at text NOT NULL, notification_sent_at text, notification_error text, FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE cascade)"
    ),
    db.prepare(
      "CREATE INDEX IF NOT EXISTS status_events_monitor_checked_idx ON status_events (monitor_id, checked_at)"
    ),
  ]);
}

export async function listMonitors(env: RuntimeEnv) {
  await ensureSchema(env);
  const { results } = await requireDb(env)
    .prepare(
      "SELECT id, journal_name, journal_slug, manuscript_url, username, notify_email, last_status, last_status_detail, last_checked_at, last_changed_at, check_count, enabled, created_at, updated_at FROM monitors ORDER BY created_at DESC"
    )
    .all<Omit<MonitorRecord, "password_ciphertext" | "password_iv" | "password_salt">>();

  return results;
}

export async function createMonitor(
  env: RuntimeEnv,
  input: {
    journalName: string;
    manuscriptUrl?: string;
    username: string;
    password: string;
    notifyEmail: string;
  }
) {
  await ensureSchema(env);

  if (!input.journalName.trim()) throw new Error("请输入期刊名称。");
  if (!input.username.trim()) throw new Error("请输入 ScholarOne 账号。");
  if (!input.password) throw new Error("请输入 ScholarOne 密码。");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.notifyEmail.trim())) {
    throw new Error("请输入有效的通知邮箱。");
  }

  const journal = resolveJournal(input.journalName, input.manuscriptUrl);
  const encrypted = await encryptPassword(input.password, requireSecret(env));
  const timestamp = nowIso();
  const monitorId = id("mon");

  await requireDb(env)
    .prepare(
      "INSERT INTO monitors (id, journal_name, journal_slug, manuscript_url, username, password_ciphertext, password_iv, password_salt, notify_email, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(
      monitorId,
      journal.journalName,
      journal.slug,
      journal.manuscriptUrl,
      input.username.trim(),
      encrypted.ciphertext,
      encrypted.iv,
      encrypted.salt,
      input.notifyEmail.trim(),
      timestamp,
      timestamp
    )
    .run();

  return { id: monitorId, ...journal, username: input.username.trim(), notifyEmail: input.notifyEmail.trim() };
}

export async function getMonitor(env: RuntimeEnv, monitorId: string) {
  await ensureSchema(env);
  const monitor = await requireDb(env)
    .prepare("SELECT * FROM monitors WHERE id = ?")
    .bind(monitorId)
    .first<MonitorRecord>();

  if (!monitor) throw new Error("没有找到该监控任务。");
  return monitor;
}

export async function listEvents(env: RuntimeEnv, monitorId: string) {
  await ensureSchema(env);
  const { results } = await requireDb(env)
    .prepare("SELECT * FROM status_events WHERE monitor_id = ? ORDER BY checked_at DESC LIMIT 20")
    .bind(monitorId)
    .all<StatusEventRecord>();

  return results;
}

export async function runMonitorCheck(
  env: RuntimeEnv,
  monitorId: string,
  options: { source?: string } = {}
) {
  await ensureSchema(env);
  const monitor = await getMonitor(env, monitorId);
  const password = await decryptPassword(
    monitor.password_ciphertext,
    monitor.password_iv,
    monitor.password_salt,
    requireSecret(env)
  );
  const checked = await checkSubmissionStatus(env, {
    journalName: monitor.journal_name,
    manuscriptUrl: monitor.manuscript_url,
    username: monitor.username,
    password,
  });
  const checkedAt = checked.checkedAt || nowIso();
  const checkSource = options.source || "手动检测";
  const detail = detailWithSource(checked.detail, checkSource);
  const previousStatus = monitor.last_status;
  const changed = previousStatus !== checked.status;
  const eventId = id("evt");
  let notificationSentAt: string | null = null;
  let notificationError: string | null = null;

  if (changed) {
    const notification = await sendStatusChangeEmail(env, {
      to: monitor.notify_email,
      journalName: monitor.journal_name,
      manuscriptUrl: monitor.manuscript_url,
      previousStatus,
      currentStatus: checked.status,
      detail,
      checkedAt,
    });
    notificationSentAt = notification.sent ? nowIso() : null;
    notificationError = notification.error;
  }

  await requireDb(env).batch([
    requireDb(env)
      .prepare(
        "INSERT INTO status_events (id, monitor_id, previous_status, current_status, detail, raw_excerpt, checked_at, notification_sent_at, notification_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        eventId,
        monitor.id,
        previousStatus,
        checked.status,
        detail,
        checked.rawExcerpt || null,
        checkedAt,
        notificationSentAt,
        notificationError
      ),
    requireDb(env)
      .prepare(
        "UPDATE monitors SET last_status = ?, last_status_detail = ?, last_checked_at = ?, last_changed_at = CASE WHEN ? THEN ? ELSE last_changed_at END, check_count = check_count + 1, updated_at = ? WHERE id = ?"
      )
      .bind(
        checked.status,
        detail,
        checkedAt,
        changed ? 1 : 0,
        changed ? checkedAt : null,
        nowIso(),
        monitor.id
      ),
  ]);

  return {
    monitorId: monitor.id,
    changed,
    previousStatus,
    currentStatus: checked.status,
    detail,
    checkedAt,
    notificationSentAt,
    notificationError,
  };
}

export async function runDailyChecks(env: RuntimeEnv) {
  await ensureSchema(env);
  const { results } = await requireDb(env)
    .prepare("SELECT id FROM monitors WHERE enabled = 1 ORDER BY created_at ASC")
    .all<{ id: string }>();

  const output = [];
  for (const row of results) {
    try {
      output.push(await runMonitorCheck(env, row.id, { source: "自动检测" }));
    } catch (error) {
      output.push({
        monitorId: row.id,
        error: error instanceof Error ? error.message : "检测失败",
      });
    }
  }

  return output;
}

export async function deleteMonitor(env: RuntimeEnv, monitorId: string) {
  await ensureSchema(env);
  await requireDb(env).prepare("DELETE FROM monitors WHERE id = ?").bind(monitorId).run();
}
