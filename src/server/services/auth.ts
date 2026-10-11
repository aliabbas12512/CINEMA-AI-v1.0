import { eq } from "drizzle-orm";
import { z } from "zod";
import { hashPassword, verifyPassword } from "@/server/auth/password";
import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { ServiceError } from "./projects";

export const SignupSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Password must be at least 10 characters").max(200),
  name: z.string().trim().max(100).optional(),
});

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export async function signup(db: Db, input: z.infer<typeof SignupSchema>) {
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email));
  if (existing) throw new ServiceError(409, "An account with this email already exists.");
  const [u] = await db
    .insert(users)
    .values({ email: input.email, passwordHash: await hashPassword(input.password), name: input.name || null })
    .returning({ id: users.id, email: users.email, name: users.name });
  return u!;
}

// Equalize timing for unknown emails.
const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "==";

export async function login(db: Db, input: z.infer<typeof LoginSchema>) {
  const [u] = await db.select().from(users).where(eq(users.email, input.email));
  const ok = await verifyPassword(input.password, u?.passwordHash ?? DUMMY_HASH);
  if (!u || !ok) throw new ServiceError(401, "Invalid email or password.");
  return { id: u.id, email: u.email, name: u.name };
}
