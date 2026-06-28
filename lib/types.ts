export interface RuntimeEnv {
  DB: D1Database;
  APP_SECRET?: string;
  CRON_SECRET?: string;
  RESEND_API_KEY?: string;
  MAIL_FROM?: string;
  IEEE_CHECKER_ENDPOINT?: string;
  IEEE_CHECKER_TOKEN?: string;
  DAILY_CHECK_DELAY_MS?: string;
}

export interface MonitorRecord {
  id: string;
  journal_name: string;
  journal_slug: string;
  manuscript_url: string;
  username: string;
  password_ciphertext: string;
  password_iv: string;
  password_salt: string;
  notify_email: string;
  last_status: string | null;
  last_status_detail: string | null;
  last_checked_at: string | null;
  last_changed_at: string | null;
  check_count: number;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface StatusEventRecord {
  id: string;
  monitor_id: string;
  previous_status: string | null;
  current_status: string;
  detail: string | null;
  raw_excerpt: string | null;
  checked_at: string;
  notification_sent_at: string | null;
  notification_error: string | null;
}

export interface CheckerResult {
  status: string;
  detail?: string;
  rawExcerpt?: string;
  checkedAt?: string;
}
