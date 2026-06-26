import type { RuntimeEnv } from "./types";

export async function sendStatusChangeEmail(
  env: RuntimeEnv,
  input: {
    to: string;
    journalName: string;
    manuscriptUrl: string;
    previousStatus: string | null;
    currentStatus: string;
    detail?: string | null;
    checkedAt: string;
  }
) {
  if (!env.RESEND_API_KEY) {
    return { sent: false, error: null };
  }

  const from = env.MAIL_FROM || "IEEE 投稿状态识别 <status@hits.asia>";
  const subject = `投稿状态变化：${input.journalName}`;
  const previous = input.previousStatus || "首次检测";
  const text = [
    `期刊：${input.journalName}`,
    `投稿平台：${input.manuscriptUrl}`,
    `原状态：${previous}`,
    `当前状态：${input.currentStatus}`,
    input.detail ? `详情：${input.detail}` : "",
    `检测时间：${input.checkedAt}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [input.to],
      subject,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return { sent: false, error: `Resend 返回 ${response.status}: ${body.slice(0, 300)}` };
  }

  return { sent: true, error: null };
}
