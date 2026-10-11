import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db/client";
import { getSessionUser, SESSION_COOKIE, type SessionUser } from "./session";

export async function getPageUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getSessionUser(getDb(), token);
}

export async function requirePageUser(): Promise<SessionUser> {
  const u = await getPageUser();
  if (!u) redirect("/login");
  return u;
}
