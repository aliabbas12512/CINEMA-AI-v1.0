import { expect, test } from "@playwright/test";

const SCRIPT = `Shehzada Zain aur Jadui Chiragh.
Ek zamane ki baat hai, Crystal Palace mein Shehzada Zain rehta tha. Ek raat usay ek sunehra chiragh mila.
Zain ne kaha: "Yeh chiragh kaisa hai?" Achanak Pari Noor zahir hui aur boli: "Main tumhari madad karungi."
Dono ne mil kar saltanat ko andheron se bachaya aur roshni wapas aa gayi.`;

test("sign up, create a project, start generation and see REAL backend state", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await page.goto("/signup");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill("correct-horse-battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: /Turn one story/ })).toBeVisible();

  await page.getByRole("link", { name: /Create New Video/ }).first().click();
  await expect(page.getByLabel(/Story \/ Script/)).toBeVisible();
  // Defaults required by the product brief.
  await expect(page.getByLabel("Duration")).toHaveValue("600");
  await expect(page.getByLabel("Resolution")).toHaveValue("1080p");
  await expect(page.getByLabel("Aspect")).toHaveValue("16:9");
  await expect(page.getByLabel("Visual style")).toHaveValue("cinematic_fantasy");

  await page.getByLabel(/Story \/ Script/).fill(SCRIPT);
  await page.getByRole("button", { name: /Generate Video/ }).click();
  await page.waitForURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByText("Overall progress (from backend unit state)")).toBeVisible();

  // Whatever the server's provider configuration is, the page must show the true outcome:
  // either a running stage or an honest, specific error - never a fake success.
  const outcome = page.getByRole("alert").or(page.getByText(/● /).first());
  await expect(outcome.first()).toBeVisible({ timeout: 60_000 });
  const alert = page.getByRole("alert");
  if (await alert.count()) {
    await expect(alert.first()).toContainText(/not configured|failed|missing/i);
    await expect(page.getByRole("link", { name: /Download video/ })).toHaveCount(0);
  }
});

test("unauthenticated users cannot read projects or assets", async ({ request }) => {
  expect((await request.get("/api/projects")).status()).toBe(401);
  expect((await request.get("/api/assets/00000000-0000-0000-0000-000000000000")).status()).toBe(401);
  const res = await request.post("/api/projects", { data: { script: "x".repeat(300) }, headers: { Origin: "https://evil.example" } });
  expect(res.status()).toBe(403);
});
