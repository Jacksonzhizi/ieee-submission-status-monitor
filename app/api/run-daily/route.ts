import { env } from "cloudflare:workers";
import { runDailyChecks } from "../../../lib/monitoring";
import type { RuntimeEnv } from "../../../lib/types";

function toError(error: unknown) {
  return error instanceof Error ? error.message : "批量检测失败";
}

export async function POST(request: Request) {
  try {
    const expected = (env as RuntimeEnv).CRON_SECRET;
    const provided = request.headers.get("x-cron-secret");
    if (expected && provided !== expected) {
      return Response.json({ error: "未授权的定时检测请求。" }, { status: 401 });
    }

    const results = await runDailyChecks(env as RuntimeEnv);
    return Response.json({ results });
  } catch (error) {
    return Response.json({ error: toError(error) }, { status: 500 });
  }
}
