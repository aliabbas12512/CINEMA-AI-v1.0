import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { getPageUser } from "@/server/auth/page-auth";

export default async function SignupPage() {
  if (await getPageUser()) redirect("/");
  return <AuthForm mode="signup" />;
}
