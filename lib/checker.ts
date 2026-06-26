import type { CheckerResult, RuntimeEnv } from "./types";

export async function checkSubmissionStatus(
  env: RuntimeEnv,
  input: {
    journalName: string;
    manuscriptUrl: string;
    username: string;
    password: string;
  }
): Promise<CheckerResult> {
  if (!env.IEEE_CHECKER_ENDPOINT) {
    throw new Error(
      "尚未配置 IEEE_CHECKER_ENDPOINT。主站已能保存任务和触发检测，但 ScholarOne 登录检测需要一个可运行浏览器自动化的后端服务。"
    );
  }

  const response = await fetch(env.IEEE_CHECKER_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.IEEE_CHECKER_TOKEN
        ? { Authorization: `Bearer ${env.IEEE_CHECKER_TOKEN}` }
        : {}),
    },
    body: JSON.stringify(input),
  });

  const body = (await response.json().catch(() => null)) as Partial<CheckerResult> & {
    error?: string;
  } | null;

  if (!response.ok) {
    throw new Error(body?.error || `检测服务返回 HTTP ${response.status}`);
  }

  if (!body?.status) {
    throw new Error("检测服务未返回 status 字段。");
  }

  return {
    status: body.status.trim(),
    detail: body.detail?.trim(),
    rawExcerpt: body.rawExcerpt?.slice(0, 1000),
    checkedAt: body.checkedAt,
  };
}
