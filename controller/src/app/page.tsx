import { redirect } from "next/navigation";
import { currentAdmin } from "@/lib/auth";

export default async function Home() {
  const admin = await currentAdmin();
  redirect(admin ? "/dashboard" : "/login");
}
