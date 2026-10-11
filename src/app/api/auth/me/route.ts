import { handler, json, requireUser } from "@/server/http/api";

export const runtime = "nodejs";

export const GET = handler(async () => json({ user: await requireUser() }));
