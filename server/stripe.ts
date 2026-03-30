import Stripe from "stripe";
import {
  updateUserPlan,
  setUserPlanAndResetCount,
  getUserByStripeCustomerId,
  getUserByStripeSubscriptionId,
  getOrCreateUser,
} from "./db";
import { sendAlert } from "./mailer";

const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || "";
const ILIMITADO_PRICE_ID = process.env.STRIPE_ILIMITADO_PRICE_ID || "";

function extractStripeKey(raw: string): string {
  const key = raw.trim().split(/\s+/)[0];
  if (!key.startsWith("sk_test_") && !key.startsWith("sk_live_")) {
    throw new Error("STRIPE_SECRET_KEY no tiene formato válido (debe empezar con sk_test_ o sk_live_)");
  }
  if (key.length < 80) {
    throw new Error(`STRIPE_SECRET_KEY parece incompleta (${key.length} chars). Verifica el valor en Secrets.`);
  }
  return key;
}

function getStripe(): Stripe {
  const rawKey = process.env.STRIPE_SECRET_KEY;
  if (!rawKey) throw new Error("STRIPE_SECRET_KEY no configurada");
  const key = extractStripeKey(rawKey);
  return new Stripe(key, { apiVersion: "2024-11-20.acacia" });
}

function planNameFromPriceId(priceId: string): string {
  if (priceId === PRO_PRICE_ID) return "pro";
  if (priceId === ILIMITADO_PRICE_ID) return "ilimitado";
  return "pro";
}

export async function createCheckoutSession(
  priceId: string,
  clerkUserId: string,
  userEmail: string | undefined
): Promise<string> {
  try {
    const stripe = getStripe();
    const appUrl =
      process.env.APP_URL ||
      "https://optimizapro-analizador-ads.yulieska2025.repl.co";

    const params: Stripe.Checkout.SessionCreateParams = {
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      client_reference_id: clerkUserId,
      success_url: `${appUrl}/upgrade?success=true`,
      cancel_url: `${appUrl}/upgrade?canceled=true`,
      allow_promotion_codes: true,
    };

    if (userEmail) {
      params.customer_email = userEmail;
    }

    const session = await stripe.checkout.sessions.create(params);
    if (!session.url) throw new Error("Stripe no devolvió una URL de checkout");
    return session.url;
  } catch (error: any) {
    console.error("[Stripe] Error al crear sesión:", error.message);
    throw error;
  }
}

export async function handleStripeWebhook(
  rawBody: Buffer,
  signature: string
): Promise<void> {
  console.log("[Stripe Webhook] Webhook recibido");

  const stripe = getStripe();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  console.log("[Stripe Webhook] ========== INICIALIZANDO WEBHOOK ==========");
  console.log(`[Stripe Webhook] Webhook secret configurado: ${!!webhookSecret}`);
  console.log(`[Stripe Webhook] Raw body length: ${rawBody.length}`);
  console.log(`[Stripe Webhook] Signature: ${signature.substring(0, 20)}...`);

  if (!webhookSecret) throw new Error("STRIPE_WEBHOOK_SECRET no configurada");

  let event: Stripe.Event;
  try {
    console.log("[Stripe Webhook] Validando firma...");
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    console.log("[Stripe Webhook] ✅ Firma validada correctamente");
    console.log(`✅ Firma verificada. Evento tipo: ${event.type}`);
  } catch (err: any) {
    console.error("[Stripe Webhook] ❌ Error validando firma:", err.message);
    console.error(`❌ Error de firma: ${err.message}`);
    throw new Error(`Firma de webhook inválida: ${err.message}`);
  }

  console.log(`[Stripe Webhook] Evento tipo: ${event.type}`);
  console.log(`[Stripe Webhook] ✅ Evento recibido: ${event.type}`);

  switch (event.type) {
    case "checkout.session.completed": {
      console.log("[Stripe Webhook] === CHECKOUT SESSION COMPLETED ===");
      const session = event.data.object as Stripe.Checkout.Session;

      console.log("[Stripe Webhook] Sesión completa:", JSON.stringify(session, null, 2));
      console.log("💰 checkout.session.completed - Session:", JSON.stringify(session, null, 2));

      const clerkUserId = session.client_reference_id;
      const customerEmail = session.customer_details?.email;
      console.log(`[Stripe Webhook] userId: ${clerkUserId}`);
      console.log(`💰 client_reference_id: ${clerkUserId}`);
      console.log(`💰 customer_email: ${customerEmail}`);

      const stripeCustomerId =
        typeof session.customer === "string"
          ? session.customer
          : session.customer?.id ?? null;
      const stripeSubscriptionId =
        typeof session.subscription === "string"
          ? session.subscription
          : session.subscription?.id ?? null;

      console.log(`[Stripe Webhook] client_reference_id (Clerk): ${clerkUserId}`);
      console.log(`[Stripe Webhook] stripe_customer_id: ${stripeCustomerId}`);
      console.log(`[Stripe Webhook] stripe_subscription_id: ${stripeSubscriptionId}`);

      if (!clerkUserId) {
        console.error("[Stripe Webhook] ❌ checkout.session.completed sin client_reference_id");
        console.error("[Stripe Webhook] Detalles de la sesión:", JSON.stringify(session, null, 2));
        break;
      }

      let planName = "pro";
      if (stripeSubscriptionId) {
        try {
          console.log("[Stripe Webhook] Obteniendo detalles de suscripción...");
          const subscription = await stripe.subscriptions.retrieve(stripeSubscriptionId);
          const priceId = subscription.items.data[0]?.price.id ?? "";
          console.log(`[Stripe Webhook] priceId: ${priceId}`);
          planName = planNameFromPriceId(priceId);
          console.log(`[Stripe Webhook] priceId: ${priceId} → planName: ${planName}`);
        } catch (err) {
          console.error("[Stripe Webhook] Error obteniendo suscripción:", err);
        }
      }
 console.log(`[Stripe Webhook] Actualizando usuario ${clerkUserId} a plan ${planName} con contador reiniciado a 0`);
      // Usamos la nueva función que reinicia analyses_count a 0
      await setUserPlanAndResetCount(
        clerkUserId,
        planName,
        stripeCustomerId ?? undefined,
        stripeSubscriptionId ?? undefined
      );
      console.log(`[Stripe Webhook] ✅ Usuario actualizado exitosamente: ${clerkUserId} → plan ${planName}`);

      try {
        await sendAlert(
          `✅ Nueva suscripción: Plan ${planName}`,
          `Usuario Clerk: ${clerkUserId}\nPlan: ${planName}\nCliente Stripe: ${stripeCustomerId}\nSuscripción: ${stripeSubscriptionId}\nFecha: ${new Date().toISOString()}`
        );
        console.log("[Stripe Webhook] ✅ Alerta enviada exitosamente");
      } catch (alertErr) {
        console.error("[Stripe Webhook] Error enviando alerta:", alertErr);
      }
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeCustomerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
      if (stripeCustomerId) {
        const user = await getUserByStripeCustomerId(stripeCustomerId);
        if (user) {
          console.log(`[Stripe Webhook] invoice.paid para usuario ${user.clerk_id}`);
        }
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const stripeCustomerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null;
      if (stripeCustomerId) {
        const user = await getUserByStripeCustomerId(stripeCustomerId);
        await sendAlert(
          "⚠️ Pago fallido en Stripe",
          `Cliente Stripe: ${stripeCustomerId}\nUsuario: ${user?.email ?? "desconocido"}\nFecha: ${new Date().toISOString()}`
        );
      }
      break;
    }

    case "customer.subscription.updated": {
      const subscription = event.data.object as Stripe.Subscription;
      const stripeCustomerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id ?? null;

      if (!stripeCustomerId) break;
      const user = await getUserByStripeCustomerId(stripeCustomerId);
      if (!user) break;

      const priceId = subscription.items.data[0]?.price.id ?? "";
      const newPlan = planNameFromPriceId(priceId);
      const status = subscription.status;

      if (status === "active" || status === "trialing") {
        // También reiniciamos el contador si se actualiza el plan (ej. de Pro a Ilimitado)
        console.log(`[Stripe Webhook] Suscripción actualizada: ${user.clerk_id} → ${newPlan} (reiniciando contador)`);
        await setUserPlanAndResetCount(user.clerk_id, newPlan, stripeCustomerId, subscription.id);
      } else if (status === "past_due" || status === "unpaid") {
        console.warn(`[Stripe Webhook] Suscripción en mora para ${user.clerk_id}`);
      }
      break;
    }
   case "customer.subscription.deleted": {
      const subscription = event.data.object as Stripe.Subscription;
      const stripeCustomerId =
        typeof subscription.customer === "string"
          ? subscription.customer
          : subscription.customer?.id ?? null;

      if (!stripeCustomerId) break;
      const user = await getUserByStripeCustomerId(stripeCustomerId);
      if (!user) break;

      // Al cancelar, pasa a gratuito pero no reiniciamos el contador (se maneja con el reinicio mensual)
      await updateUserPlan(user.clerk_id, "free");
      console.log(`[Stripe Webhook] Suscripción cancelada: ${user.clerk_id} → free`);

      await sendAlert(
        "📉 Suscripción cancelada",
        `Usuario: ${user.email ?? user.clerk_id}\nFecha: ${new Date().toISOString()}`
      );
      break;
    }

    default:
      console.log(`[Stripe Webhook] Evento no manejado: ${event.type}`);
  }
}

export const PLANS = [
  {
    id: "free",
    name: "Gratuito",
    price: "0€",
    period: "",
    analyses: "2 análisis / mes",
    priceId: null,
  },
  {
    id: "pro",
    name: "Pro",
    price: "9€",
    period: "/ mes",
    analyses: "50 análisis / mes",
    priceId: PRO_PRICE_ID,
  },
  {
    id: "ilimitado",
    name: "Agencia",
    price: "15€",
    period: "/ mes",
    analyses: "Análisis ilimitados",
    priceId: ILIMITADO_PRICE_ID,
  },
];

    

