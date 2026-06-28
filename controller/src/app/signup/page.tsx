import { redirect } from "next/navigation";
import { createAdmin, setSessionCookie } from "@/lib/auth";
import { AUTH_LIMIT, clientIp, consume } from "@/lib/ratelimit";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const dynamic = "force-dynamic";

async function signup(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const token = String(formData.get("token") ?? "");
  // Throttle by IP so the shared signup token can't be brute-forced at server speed (H-02).
  const ip = await clientIp();
  if (!consume(`signup:ip:${ip}`, AUTH_LIMIT)) {
    redirect("/signup?error=Too+many+attempts.+Try+again+later.");
  }
  try {
    const admin = await createAdmin(name, email, password, token);
    await setSessionCookie(admin);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Signup failed";
    redirect(`/signup?error=${encodeURIComponent(msg)}`);
  }
  redirect("/dashboard");
}

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
                L
              </span>
              <h1 className="text-xl font-semibold tracking-tight">Register admin</h1>
            </div>
            <p className="text-sm text-muted-foreground">
              Requires the signup token configured on the controller.
            </p>
          </div>
          <form action={signup} className="space-y-4">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input id="name" name="name" required />
            </div>
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required minLength={8} />
            </div>
            <div>
              <Label htmlFor="token">Signup token</Label>
              <Input id="token" name="token" required />
            </div>
            <Button type="submit" className="w-full">
              Create account
            </Button>
          </form>
          {error && <p className="text-sm text-err">{error}</p>}
          <p className="text-sm text-muted-foreground">
            <a href="/login" className="text-primary hover:underline">
              Back to sign in
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
