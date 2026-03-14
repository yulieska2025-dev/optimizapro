import { BrevoClient } from "@getbrevo/brevo";

const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const ALERT_EMAIL = process.env.ALERT_EMAIL || "yulieska2025@gmail.com";
// El remitente debe ser el mismo email que recibe alertas para evitar problemas de verificación de dominio
const FROM_EMAIL = ALERT_EMAIL;
const FROM_NAME = "OptimizaPro Alertas";

console.log("[Mailer] Init - BREVO_API_KEY:", BREVO_API_KEY ? "✅ SET" : "❌ MISSING");
console.log("[Mailer] Init - ALERT_EMAIL:", ALERT_EMAIL);

let client: BrevoClient | null = null;

function getClient(): BrevoClient | null {
  if (!BREVO_API_KEY) {
    console.warn("[Mailer] ❌ BREVO_API_KEY no configurada — alertas desactivadas");
    return null;
  }
  if (!client) {
    client = new BrevoClient({ apiKey: BREVO_API_KEY });
    console.log("[Mailer] ✅ BrevoClient inicializado");
  }
  return client;
}

export async function sendAlert(subject: string, message: string): Promise<void> {
  console.log(`\n[Mailer] sendAlert → "${subject}"`);

  const c = getClient();
  if (!c) return;

  try {
    const response = await c.transactionalEmails.sendTransacEmail({
      subject: `[OptimizaPro] ${subject}`,
      sender: { email: FROM_EMAIL, name: FROM_NAME },
      to: [{ email: ALERT_EMAIL }],
      textContent: message,
    });
    console.log(`[Mailer] ✅ Email enviado a ${ALERT_EMAIL} — messageId:`, (response as any)?.messageId || JSON.stringify(response));
  } catch (err: any) {
    console.error("[Mailer] ❌ Error enviando email:", err?.body || err?.message || err);
  }
}
