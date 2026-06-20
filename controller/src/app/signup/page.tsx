import { redirect } from "next/navigation";
import { createAdmin, setSessionCookie } from "@/lib/auth";

export const dynamic = "force-dynamic";

async function signup(formData: FormData) {
  "use server";
  const name = String(formData.get("name") ?? "");
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const token = String(formData.get("token") ?? "");
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
    <div className="auth-wrap">
      <div className="card auth-card">
        <h2>Register admin</h2>
        <p className="muted">Requires the signup token configured on the controller.</p>
        <form action={signup}>
          <label htmlFor="name">Name</label>
          <input id="name" name="name" required />
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" required minLength={8} />
          <label htmlFor="token">Signup token</label>
          <input id="token" name="token" required />
          <button type="submit">Create account</button>
        </form>
        {error && <p className="error">{error}</p>}
        <p className="muted" style={{ marginTop: 16 }}>
          <a href="/login">Back to sign in</a>
        </p>
      </div>
    </div>
  );
}
