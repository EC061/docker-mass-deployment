import { redirect } from "next/navigation";
import { adminCount, setSessionCookie, verifyLogin } from "@/lib/auth";
import { AUTH_LIMIT, clientIp, consume } from "@/lib/ratelimit";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  // Throttle by IP and by target email so neither password spraying nor a focused guess runs at
  // server speed (H-02).
  const ip = await clientIp();
  if (!consume(`login:ip:${ip}`, AUTH_LIMIT) || !consume(`login:email:${email}`, AUTH_LIMIT)) {
    redirect("/login?error=Too+many+attempts.+Try+again+later.");
  }
  const admin = await verifyLogin(email, password);
  if (!admin) redirect("/login?error=Invalid+email+or+password");
  await setSessionCookie(admin);
  redirect("/dashboard");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const noAdmins = adminCount() === 0;
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <Card className="w-full max-w-sm">
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-sm font-bold text-primary-foreground">
                L
              </span>
              <h1 className="text-xl font-semibold tracking-tight">Sign in</h1>
            </div>
            {noAdmins && (
              <p className="text-sm text-muted-foreground">
                No admins yet.{" "}
                <a href="/signup" className="text-primary hover:underline">
                  Create the first account
                </a>{" "}
                using the signup token.
              </p>
            )}
          </div>
          <form action={login} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required />
            </div>
            <div>
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" required />
            </div>
            <Button type="submit" className="w-full">
              Sign in
            </Button>
          </form>
          {error && <p className="text-sm text-err">{error}</p>}
          <p className="text-sm text-muted-foreground">
            <a href="/signup" className="text-primary hover:underline">
              Register a new admin
            </a>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
