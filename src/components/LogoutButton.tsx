"use client";

import { useRouter } from "next/navigation";
import { api } from "@/lib/client-api";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="rounded-lg px-3 py-2 text-white/50 hover:bg-white/5 hover:text-white"
      onClick={async () => {
        await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
