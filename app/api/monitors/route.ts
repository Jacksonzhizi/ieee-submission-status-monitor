import { env } from "cloudflare:workers";
import { createMonitor, listMonitors } from "../../../lib/monitoring";
import type { RuntimeEnv } from "../../../lib/types";

function toError(error: unknown) {
  return error instanceof Error ? error.message : "请求失败";
}

export async function GET() {
  try {
    const monitors = await listMonitors(env as RuntimeEnv);
    return Response.json({ monitors });
  } catch (error) {
    return Response.json({ error: toError(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json()) as {
      journalName?: string;
      manuscriptUrl?: string;
      username?: string;
      password?: string;
      notifyEmail?: string;
    };

    const monitor = await createMonitor(env as RuntimeEnv, {
      journalName: payload.journalName ?? "",
      manuscriptUrl: payload.manuscriptUrl,
      username: payload.username ?? "",
      password: payload.password ?? "",
      notifyEmail: payload.notifyEmail ?? "",
    });

    return Response.json({ monitor }, { status: 201 });
  } catch (error) {
    return Response.json({ error: toError(error) }, { status: 400 });
  }
}
