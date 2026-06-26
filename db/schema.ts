import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const monitors = sqliteTable("monitors", {
  id: text("id").primaryKey(),
  journalName: text("journal_name").notNull(),
  journalSlug: text("journal_slug").notNull(),
  manuscriptUrl: text("manuscript_url").notNull(),
  username: text("username").notNull(),
  passwordCiphertext: text("password_ciphertext").notNull(),
  passwordIv: text("password_iv").notNull(),
  passwordSalt: text("password_salt").notNull(),
  notifyEmail: text("notify_email").notNull(),
  lastStatus: text("last_status"),
  lastStatusDetail: text("last_status_detail"),
  lastCheckedAt: text("last_checked_at"),
  lastChangedAt: text("last_changed_at"),
  checkCount: integer("check_count").notNull().default(0),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const statusEvents = sqliteTable(
  "status_events",
  {
    id: text("id").primaryKey(),
    monitorId: text("monitor_id")
      .notNull()
      .references(() => monitors.id, { onDelete: "cascade" }),
    previousStatus: text("previous_status"),
    currentStatus: text("current_status").notNull(),
    detail: text("detail"),
    rawExcerpt: text("raw_excerpt"),
    checkedAt: text("checked_at").notNull(),
    notificationSentAt: text("notification_sent_at"),
    notificationError: text("notification_error"),
  },
  (table) => [
    index("status_events_monitor_checked_idx").on(
      table.monitorId,
      table.checkedAt
    ),
  ]
);
