import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { getConfigSyncStatus, updateConfigSync, type SyncRequest } from "@/lib/config-sync";
import { isRecord, parseBrowserPreferences, parseRepository } from "@/lib/config-sync-profile";

export const dynamic = "force-dynamic";

export async function GET() {
  try { return NextResponse.json(getConfigSyncStatus(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid sync configuration" }, { status: 500 }); }
}

async function mutate(req: Request, method: "PUT" | "POST") {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  let request: SyncRequest;
  try {
    const text = await req.text();
    if (text.length > 16 * 1024) throw new Error("Sync request is too large");
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) throw new Error("Invalid sync request");
    if (method === "PUT") {
      if (typeof body.enabled !== "boolean" || typeof body.repository !== "string") throw new Error("enabled and repository are required");
      request = { action: "configure", enabled: body.enabled, repository: body.repository ? parseRepository(body.repository) : "" };
    } else if (body.action === "browser") {
      request = { action: "browser", browser: parseBrowserPreferences(body.browser), browserBase: parseBrowserPreferences(body.browserBase ?? {}) };
    } else if (body.action === "sync") {
      if (body.resolve !== undefined && body.resolve !== "local" && body.resolve !== "remote") throw new Error("Invalid conflict resolution");
      request = { action: "sync", resolve: body.resolve };
    } else throw new Error("Unsupported sync action");
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid sync request" }, { status: 400 });
  }
  try { return NextResponse.json(await updateConfigSync(request)); }
  catch (error) {
    const busy = (error as NodeJS.ErrnoException).code === "ELOCKED";
    return NextResponse.json({ error: busy ? "Sync is already running; try again shortly" : error instanceof Error ? error.message : "Configuration sync failed" }, { status: busy ? 409 : 500 });
  }
}

export async function PUT(req: Request) { return mutate(req, "PUT"); }
export async function POST(req: Request) { return mutate(req, "POST"); }
