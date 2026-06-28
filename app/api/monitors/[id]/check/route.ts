import { env } from "cloudflare:workers";
import { runMonitorCheck } from "../../../../../lib/monitoring";
import type { RuntimeEnv } from "../../../../../lib/types";

function toError(error: unknown) {
  return error instanceof Error ? error.message : "检测失败";
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const result = await runMonitorCheck(env as RuntimeEnv, id, { source: "手动检测" });
    return Response.json({ result });
  } catch (error) {
    return Response.json({ error: toError(error) }, { status: 500 });
  }
}
