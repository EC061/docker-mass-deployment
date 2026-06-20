import { redirect } from "next/navigation";
import { adminCount, setSessionCookie, verifyLogin } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function login(formData: FormData) {
  "use server";
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const admin = await verifyLogin(email, password);
  if (!admin) redirect("/login?error=Invalid+email+or+password");
  await setSessionCookie(admin);
  redirect("/dashboard");
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const noAdmins = adminCount() === 0;
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <h2>Sign in</h2>
        {noAdmins && (
          <p className="muted">
            No admins yet. <a href="/signup">Create the first account</a> using the signup token.
          </p>
        )}
        <form action={login}>
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required />
          <button type="submit">Sign in</button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="muted" style={{ marginTop: 16 }}>
          <a href="/signup">Register a new admin</a>
        </p>
      </div>
    </div>
  );
}
