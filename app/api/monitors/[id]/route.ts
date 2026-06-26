import { env } from "cloudflare:workers";
import { deleteMonitor, listEvents } from "../../../../lib/monitoring";
import type { RuntimeEnv } from "../../../../lib/types";

function toError(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const events = await listEvents(env as RuntimeEnv, id);
    return Response.json({ events });
  } catch (error) {
    return Response.json({ error: toError(error) }, { status: 500 });
  }
}

export async function DELETE(_: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    await deleteMonitor(env as RuntimeEnv, id);
    return Response.json({ ok: true });
  } catch (error) {
    return Response.json({ error: toError(error) }, { status: 500 });
  }
}
