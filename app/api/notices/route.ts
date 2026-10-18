import { env } from "cloudflare:workers";
import { checkOrigin, errorResponse, json, readJSON, requireOwner } from "../../../lib/notice-input.ts";
import { deleteNotices, importNotices, listNotices, updateNotice } from "../../../lib/notice-store.ts";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try { return json({ notices: await listNotices(env.DB!, requireOwner(request.headers)) }); }
  catch (error) { return errorResponse(error); }
}

async function mutate(request: Request) {
  try {
    const owner = requireOwner(request.headers);
    checkOrigin(request);
    const body = await readJSON(request);
    if (request.method === "POST") return json(await importNotices(env.DB!, owner, body.notices, "manual"));
    if (request.method === "PATCH") return json({ notice: await updateNotice(env.DB!, owner, body.id, body.patch) });
    await deleteNotices(env.DB!, owner, body.ids);
    return json({ ok: true });
  } catch (error) { return errorResponse(error); }
}
export const POST = mutate;
export const PATCH = mutate;
export const DELETE = mutate;
