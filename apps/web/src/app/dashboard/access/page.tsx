import { redirect } from "next/navigation";

export default function LegacyAgentAccessPage() {
  redirect("/dashboard/agents");
}
