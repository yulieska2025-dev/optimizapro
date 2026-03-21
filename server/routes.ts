// 1. IMPORTS
import type { Express } from "express";
import { createServer, type Server } from "http";
import multer from "multer";
import path from "path";
import fs from "fs";
import { parse } from "csv-parse/sync";
import OpenAI from "openai";
import sharp from "sharp";
import { ClerkExpressWithAuth, ClerkExpressRequireAuth } from "@clerk/clerk-sdk-node";
import { getOrCreateUser, resetMonthlyCountIfNeeded, incrementAnalysisCount, checkIpLimit, registerIp, type User } from "./db";
import { sendAlert } from "./mailer";
import { createCheckoutSession, handleStripeWebhook, PLANS } from "./stripe";

// 2. CONFIGURACIÓN
const uploadsDir = path.join(process.cwd(), "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

let basePrompt = "";
try {
  basePrompt = fs.readFileSync(path.join(process.cwd(), "prompt_base.txt"), "utf-8");
} catch (err) {
  console.error("Error cargando prompt_base.txt:", err);
}

const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".csv"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten imágenes (JPG, PNG, WEBP) o CSV"));
    }
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 3. FUNCIONES AUXILIARES

async function checkBudget() {
  try {
    const budget = parseFloat(process.env.OPENAI_MONTHLY_BUDGET || "5");
    const usage = await (openai as any).usage.retrieve({
      start_date: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0]
    });
   
    const totalSpent = usage.total_usage / 100;
    const percentUsed = (totalSpent / budget) * 100;
   
    if (percentUsed > 90) {
      throw new Error(`Límite de presupuesto mensual alcanzado (${percentUsed.toFixed(1)}%). No se pueden realizar más análisis hasta el próximo mes.`);
    }
    return true;
  } catch (error) {
    console.error('Error verificando presupuesto:', error);
    return true;
  }
}

function parseNum(val: string | undefined): number {
  if (!val) return NaN;
  return parseFloat(val.replace(/[%€$,\s]/g, ""));
}

function findCol(record: Record<string, string>, ...candidates: string[]): string | undefined {
  const keys = Object.keys(record);
  for (const c of candidates) {
    const found = keys.find((k) => k.toLowerCase().includes(c.toLowerCase()));
    if (found) return found;
  }
  return undefined;
}

function computeBudgetDirectives(records: Record<string, string>[]): string {
  const spendCol = findCol(records[0], "spend", "gasto", "cost");
  const roasCol = findCol(records[0], "roas");
  const nameCol = findCol(records[0], "campaign", "name", "camp");

  if (!spendCol || !roasCol || !nameCol) return "";

  const campaigns = records.map(r => ({
    name: r[nameCol] || "Sin nombre",
    spend: parseNum(r[spendCol]),
    roas: parseNum(r[roasCol])
  })).filter(c => !isNaN(c.spend) && !isNaN(c.roas));

  if (campaigns.length === 0) return "";

  const totalSpend = campaigns.reduce((acc, c) => acc + c.spend, 0);
  const avgRoas = campaigns.reduce((acc, c) => acc + c.roas, 0) / campaigns.length;

  const overSpenders = campaigns.filter(c => c.spend > (totalSpend / campaigns.length) * 1.5 && c.roas < avgRoas * 0.8);
  const underSpenders = campaigns.filter(c => c.roas > avgRoas * 1.2 && c.spend < (totalSpend / campaigns.length) * 0.7);

  let advice = "\n💰 **CONTROL DE PRESUPUESTO Y ENRUTAMIENTO INTELIGENTE**\n";
  if (overSpenders.length > 0) {
    advice += `⚠️ **Fuga de presupuesto detectada**: Las campañas ${overSpenders.map(c => `"${c.name}"`).join(", ")} están consumiendo un % desproporcionado del gasto con un ROAS subóptimo. Reducir su presupuesto un 20% y reasignarlo.\n`;
  }
  if (underSpenders.length > 0) {
    advice += `🚀 **Oportunidad de escalado**: Las campañas ${underSpenders.map(c => `"${c.name}"`).join(", ")} tienen un ROAS excelente pero bajo presupuesto relativo. Aumentar presupuesto un 15-20% gradualmente.\n`;
  }
  if (overSpenders.length === 0 && underSpenders.length === 0) {
    advice += "✅ El presupuesto está distribuido de forma eficiente según el rendimiento actual.\n";
  }
  return advice;
}

const SYSTEM_PROMPT = `Eres un sistema de IA sobrehumano para analizar campañas de Facebook Ads con Andrómeda 2026. Genera un análisis con la siguiente estructura EXACTA. Usa el formato indicado, sin añadir texto introductorio ni conclusivo.

### 1. GLOBAL
- Métricas medias: CPM=〈media〉, CTR=〈media〉, CPC=〈media〉, Frec=〈media〉, ROAS=〈media〉.
- Outliers (más de 2σ): [lista de campañas con métrica desviada].
- Correlaciones: 〈CPM vs Frec: Pearson〉, 〈CTR vs ROAS: Pearson〉.
### 2. POR CAMPAÑA (repite para cada una)
**Campaña: [Nombre]**
- Spend | CPC | CPM | CTR | Frec | ROAS | Conv.
- CPA: [spend / conversiones] (si conversiones > 0, sino "N/A")
- Tasa conversión: [(conversiones / clics) * 100]%
- Valor medio pedido estimado: [(spend * ROAS) / conversiones] (si conversiones > 0, sino "N/A")
- Benchmarks: (industria / cluster / best) → 🟢🟡🔴 para cada métrica.
- Predicción 7d: sin acción → ROAS entre [actual*0.9] y [actual*1.0]; con acción → ROAS entre [actual*1.0] y [actual*1.2].
- Índice fatiga:
   - Si frecuencia ≤ 3.5: "No aplica (frecuencia saludable)"
   - Si frecuencia > 3.5: [calcular como min(100, (frecuencia-3.5)*40 + (CPM-10)*5)]
- Riesgo Entity ID: [bajo|medio|alto]. Posibles competidores: [lista de campañas con nombre similar y frecuencia > 3].
- Diagnóstico: 🟢🟡🔴 (índice <20, 20-60, >60).

### 3. INSIGHTS AVANZADOS (solo si aplica)
- **Creativo enamorado**: [Campañas con Frec>3.5 y CPM<12 y CTR>1.5]. Explicación: 〈razón algorítmica〉. Replicar: 〈ángulo + 2 formatos con copy ejemplo〉.
- **Aprendizaje secuencial**: [Par de campañas A (alto CPA) y B (bajo CPA)]. Impacto si se pausa A: 〈% aumento CPA en B〉.
- **Fatiga invisible**: [Campañas con CPM > media+10% y CTR estable]. Acción: 〈2 nuevos creativos con ejemplos de copy〉.

### 4. MAPA ENTITY IDS (tabla)
| Grupo (concepto) | Campañas | Riesgo | Acción recomendada (con copy y formato) |
|------------------|----------|--------|------------------------------------------|
| (inferido)       |          | 🟢🟡🔴  |                                          |

### 5. ACCIONES PRIORITARIAS (ordenadas por impacto)
🔴 **Urgente (24h)**: [Campaña] → 〈acción con copy exacto, formato, ajuste puja, exclusiones〉.
🟡 **Importante (72h)**: ...
🟢 **Oportunidad (semanal)**: ...

### 6. BENCHMARKS INDIVIDUALES (tabla resumen)
| Campaña | CTR (vs ind) | CPC (vs ind) | CPM (vs ind) | Frec (vs ind) | ROAS (vs ind) |
|---------|--------------|--------------|--------------|---------------|---------------|
|         | 🟢🟡🔴        | 🟢🟡🔴       | 🟢🟡🔴       | 🟢🟡🔴        | 🟢🟡🔴        |

### 7. GLOSARIO (máx 10 palabras por término)
- Entity ID: identifica creativos similares.
- Aprendizaje secuencial: exposición múltiple necesaria.
- Diversidad semántica: variedad real de mensajes.
- Fatiga invisible: CPM sube sin caer CTR.`;

interface AndromedaDirectives {
  cpmMean: number;
  pattern4: Array<{ name: string; cpm: number; freq: number; ctr: number; condition: string }>;
  pattern5: Array<{ name: string; roas: number; ctr: number; freq: number }>;
}

function computeAndromedaDirectives(records: Record<string, string>[]): AndromedaDirectives {
  const nameCol = findCol(records[0], "campaign", "name", "camp");
  const cpmCol = findCol(records[0], "cpm");
  const freqCol = findCol(records[0], "freq");
  const ctrCol = findCol(records[0], "ctr");
  const roasCol = findCol(records[0], "roas");

  const campaigns = records.map((r) => ({
    name: nameCol ? (r[nameCol] ?? "") : "",
    cpm: parseNum(r[cpmCol]),
    freq: parseNum(r[freqCol]),
    ctr: parseNum(r[ctrCol]),
    roas: parseNum(r[roasCol]),
  }));
   const validCpms = campaigns.map((c) => c.cpm).filter((v) => !isNaN(v));
  const cpmMean = validCpms.length > 0 ? validCpms.reduce((a, b) => a + b, 0) / validCpms.length : 0;

  const pattern4: AndromedaDirectives["pattern4"] = [];
  for (const c of campaigns) {
    if (isNaN(c.cpm) || isNaN(c.freq)) continue;
    if (c.cpm >= 15 && c.freq >= 3.5) pattern4.push({ ...c, ctr: c.ctr || 0, condition: "A" });
    else if (c.cpm >= 13 && c.freq >= 3.5 && c.ctr >= 1.5) pattern4.push({ ...c, ctr: c.ctr || 0, condition: "C" });
  }

  const pattern5 = campaigns.filter(c => c.roas > 3.0 && c.ctr > 1.5 && c.freq < 3.5);

  return { cpmMean, pattern4, pattern5 };
}

function buildDirectivesBlock(directives: AndromedaDirectives): string {
  let block = "\n════════════════════════════════════════\nDIRECTIVAS PRE-COMPUTADAS\n";
  block += `CPM medio: ${directives.cpmMean.toFixed(2)}€\n`;
  if (directives.pattern4.length > 0) block += `Fatiga Invisible en: ${directives.pattern4.map(c => c.name).join(", ")}\n`;
  if (directives.pattern5.length > 0) block += `Expansión en: ${directives.pattern5.map(c => c.name).join(", ")}\n`;
  return block + "════════════════════════════════════════\n";
}

function buildCsvPrompt(csvTable: string, filename: string, directives: AndromedaDirectives, budgetAdvice: string): string {
  return `IMPORTANTE: Sé extremadamente conciso. Máximo 200 palabras por campaña. Prioriza acciones concretas sobre explicaciones largas.

Analiza: ${filename}\n${csvTable}\n${buildDirectivesBlock(directives)}\n${budgetAdvice}`;
}

function buildImagePrompt(ocrText: string, filename: string): string {
  return `IMPORTANTE: Sé extremadamente conciso. Máximo 200 palabras por campaña. Prioriza acciones concretas sobre explicaciones largas.

Analiza OCR de ${filename}:\n${ocrText}`;
}

function parseCsvToTable(filePath: string): { table: string; directives: AndromedaDirectives } {
  const content = fs.readFileSync(filePath, "utf-8");
  const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
  const directives = computeAndromedaDirectives(records);
  return { table: content, directives };
}

function deleteFile(filePath: string) {
  fs.unlink(filePath, (err) => { if (err) console.error(err.message); });
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  // Rutas públicas — ANTES del middleware de Clerk
  app.get("/api/plans", (_req, res) => {
    res.json(PLANS);
  });

  if (process.env.CLERK_SECRET_KEY) {
    // Ruta pública del webhook (ANTES del middleware de Clerk)
    app.post("/api/stripe-webhook", async (req: any, res) => {
      await handleStripeWebhook(req.rawBody, req.headers['stripe-signature']);
      res.json({ received: true });
    });

    // Middleware de Clerk para el resto de rutas /api
    app.use("/api", ClerkExpressWithAuth());

    // Ruta de prueba (opcional)
    app.get("/api/test-auth", ClerkExpressRequireAuth(), (req: any, res) => {
      console.log('✅ Usuario autenticado en test-auth:', req.auth?.userId);
      res.json({ userId: req.auth?.userId, message: "Autenticación correcta" });
    });

    console.log("Clerk middleware aplicado en /api");
  } else {
    console.warn("CLERK_SECRET_KEY no configurada. Middleware de Clerk desactivado.");
  }

  app.get("/api/protected", ClerkExpressRequireAuth(), (req: any, res) => {
    const userId = req.auth?.userId;
    res.json({ userId, message: "Autenticación correcta" });
  });

  app.get("/api/user/me", ClerkExpressRequireAuth(), async (req: any, res) => {
    console.log('req.auth.userId:', req.auth?.userId);
    try {
      const clerkId = req.auth?.userId;
      if (!clerkId) return res.status(401).json({ error: "No autenticado" });
     
      const email = req.auth?.sessionClaims?.email as string | undefined;
      const user = await getOrCreateUser(clerkId, email);
     
      const resetUser = await resetMonthlyCountIfNeeded(user);
     
      let analysesLeft: number;
      if (resetUser.plan === "free") {
        analysesLeft = Math.max(0, 2 - resetUser.analyses_count);
      } else if (resetUser.plan === "pro") {
        analysesLeft = Math.max(0, 50 - resetUser.analyses_count);
      } else {
        analysesLeft = -1;
      }
     
      res.json({
        plan: resetUser.plan,
        analysesLeft,
        analyses_count: resetUser.analyses_count,
        email: resetUser.email,
      });
    } catch (err: any) {
      console.error("Error en /api/user/me:", err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/analyze", upload.single("file"), async (req: any, res) => {
    console.log('1. Archivo recibido:', req.file ? 'OK' : 'No file');
    if (req.file) {
      console.log('   - Nombre:', req.file.originalname);
      console.log('   - Tamaño:', req.file.size);
      console.log('   - Tipo MIME:', req.file.mimetype);
      console.log('   - Ruta:', req.file.path);
    }
    if (!req.file) return res.status(400).json({ error: "Sin archivo" });

    // --- FREEMIUM CHECK ---
    let dbUser: User | null = null;
    if (process.env.CLERK_SECRET_KEY) {
      const clerkId: string | undefined = req.auth?.userId;
      console.log('[Freemium] clerkId:', clerkId ?? 'no autenticado');

      if (!clerkId) {
        return res.status(401).json({ error: "Debes iniciar sesión para analizar campañas." });
      }

      const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
                 req.connection.remoteAddress ||
                 req.socket.remoteAddress ||
                 'unknown';
      console.log('[IP] Cliente IP:', ip);

      const email: string | undefined = req.auth?.sessionClaims?.email;
      dbUser = await getOrCreateUser(clerkId, email);
     
      const isNewUser = !dbUser || !dbUser.created_at;
      if (isNewUser) {
        console.log('[IP] Nuevo usuario, verificando límite de IP...');
        if (!await checkIpLimit(ip)) {
          console.log('[IP] Límite de cuentas alcanzado para IP:', ip);
          return res.status(429).json({ error: "Has alcanzado el límite de cuentas gratuitas permitidas desde esta IP." });
        }
        await registerIp(ip, clerkId);
        console.log('[IP] IP registrada:', ip);
      }

      dbUser = await resetMonthlyCountIfNeeded(dbUser);
       console.log(`[Freemium] plan=${dbUser.plan}, analyses_count=${dbUser.analyses_count}`);

      const limit = dbUser.plan === "free" ? 2 : dbUser.plan === "pro" ? 50 : Infinity;
      if (dbUser.analyses_count >= limit) {
        console.log('[Freemium] Límite alcanzado para', clerkId);
        const msg = dbUser.plan === "free"
          ? "Has alcanzado el límite gratuito. Mejora a Pro o Ilimitado."
          : "Has alcanzado el límite de 50 análisis del plan Pro. Mejora a Ilimitado.";
        return res.status(403).json({
          error: msg,
          analyses_count: dbUser.analyses_count,
          plan: dbUser.plan,
        });
      }

      console.log(`[Freemium] Acceso permitido (${dbUser.analyses_count}/2 usados)`);
    } else {
      console.log('[Freemium] CLERK_SECRET_KEY no configurada, sin límites aplicados.');
    }
    // --- FIN FREEMIUM CHECK ---

    const isImage = [".jpg", ".jpeg", ".png", ".webp"].includes(path.extname(req.file.originalname).toLowerCase());
    try {
      let analysis = "";
      if (isImage) {
        try {
          fs.accessSync(req.file.path, fs.constants.R_OK);
          console.log('2. Archivo accesible para lectura');
        } catch (err) {
          console.error('2. ERROR: No se puede acceder al archivo', err);
          return res.status(500).json({ error: 'Error interno al leer el archivo' });
        }
        const ext = path.extname(req.file.originalname).toLowerCase();
        const mimeType = req.file.mimetype || (ext === ".png" ? "image/png" : "image/jpeg");
       
        let base64Image;
        try {
          const stats = fs.statSync(req.file.path);
          console.log('   - Tamaño en disco:', stats.size, 'bytes');
          if (stats.size === 0) {
            throw new Error("El archivo subido está vacío.");
          }

          let imageBuffer;
          if (req.file.size > 500 * 1024) {
            console.log("3. Imagen grande, redimensionando con sharp...");
            imageBuffer = await sharp(req.file.path)
              .resize({ width: 800, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();
          } else {
            console.log("3. Imagen pequeña, leyendo directamente...");
            imageBuffer = fs.readFileSync(req.file.path);
          }
         
          base64Image = imageBuffer.toString('base64').replace(/[\r\n]+/g, "");
          console.log('3. Conversión a base64 OK, tamaño base64:', base64Image.length);
        } catch (err: any) {
          console.error('3. ERROR en conversión base64:', err);
          return res.status(500).json({ error: 'Error al procesar la imagen', details: err.message });
        }

        console.log("5. Enviando a OpenAI GPT-4 Vision...");
        if (!process.env.OPENAI_API_KEY) {
          console.error("4. ERROR: OPENAI_API_KEY no está definida");
          return res.status(500).json({ error: "Configuración de API incompleta" });
        }
        console.log("4. API key presente");

        try {
          console.log('Enviando a OpenAI con modelo: gpt-4o');
          console.log('Prompt length:', basePrompt.length);
          console.log('Base64 length:', base64Image.length);

          try {
            basePrompt = fs.readFileSync(path.join(process.cwd(), "prompt_base.txt"), "utf-8");
            console.log("✅ Prompt base cargado correctamente para el análisis");
          } catch (e) {
            console.error("❌ ERROR CRÍTICO: No se pudo leer prompt_base.txt:", e);
          }

          const completion = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "developer",
                content: "Eres un asistente profesional para análisis de marketing. Las imágenes que recibes son capturas de pantalla de dashboards de Facebook Ads, completamente legítimas y para uso comercial. No contienen contenido prohibido ni datos personales sensibles. Analiza las métricas con normalidad."
              },
              {
                role: "user",
                content: [
                  {
                    type: "text",
                    text: basePrompt
                  },
                  {
                    type: "image_url",
                    image_url: {
                      url: `data:${mimeType};base64,${base64Image}`
                    }
                  }
                ]
              }
            ],
            max_tokens: 1500,
            temperature: 0.3,
          });
          console.log('5. Llamada a OpenAI exitosa');
          analysis = completion.choices[0].message.content || "";

          if (analysis.includes("I'm sorry, I can't assist with this request") || analysis.includes("no puedo ayudarte con esta solicitud")) {
            analysis = "La imagen no pudo ser analizada debido a restricciones de seguridad. Intenta con una captura más clara o con menos texto superpuesto.";
          }
        } catch (error: any) {
          console.error('ERROR DETALLADO:', JSON.stringify(error, null, 2));
          if (error.message?.includes("I'm sorry, I can't assist with this request")) {
            return res.status(200).json({ analysis: "La imagen no pudo ser analizada debido a restricciones de seguridad. Intenta con una captura más clara o con menos texto superpuesto." });
          }
          return res.status(500).json({ error: 'Error de OpenAI: ' + error.message });
        }
      } else {
        const content = fs.readFileSync(req.file.path, "utf-8");
        const records = parse(content, { columns: true, skip_empty_lines: true, trim: true });
        const { table, directives } = parseCsvToTable(req.file.path);
        const budgetAdvice = computeBudgetDirectives(records);
        const userPrompt = buildCsvPrompt(table, req.file.originalname, directives, budgetAdvice);

        let model = "gpt-3.5-turbo";
        if (records.length > 5) model = "gpt-4-turbo";
        else if (req.file.originalname.toLowerCase().includes("complejo")) model = "gpt-4-turbo";

        const completion = await openai.chat.completions.create({
          model: model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.5,
          max_tokens: 2000,
        });
        analysis = completion.choices[0].message.content || "";
      }

      if (dbUser && dbUser.plan !== "ilimitado") {
        await incrementAnalysisCount(dbUser.clerk_id);
        const updatedUser = await getOrCreateUser(dbUser.clerk_id);
        if (dbUser.plan === "free" && updatedUser.analyses_count >= 2) {
          await sendAlert(
            "📊 Métrica: Usuario gratuito alcanzó límite",
            `Email: ${dbUser.email || "desconocido"}\n` +
            `Análisis completados: ${updatedUser.analyses_count}/2\n` +
            `Fecha: ${new Date().toISOString()}\n\n` +
            `Este usuario podría ser candidato para conversión a plan Pro.`
          );
        }
        console.log(`[Freemium] Análisis completado. Contador incrementado para ${dbUser.clerk_id} (plan: ${dbUser.plan})`);
      } else if (dbUser && dbUser.plan === "ilimitado") {
        console.log(`[Freemium] Análisis ilimitado completado para ${dbUser.clerk_id} (sin contador)`);
      }

      res.json({ analysis });
    } catch (e: any) {
      let errorResponse;
      const errorMsg = e.message ?? String(e);
      const isOpenAIError = errorMsg.includes("insufficient_quota") ||
                            errorMsg.includes("rate_limit") ||
                            errorMsg.includes("401") ||
                            errorMsg.includes("billing");
     
      try {
        errorResponse = JSON.parse(errorMsg);
      } catch {
        errorResponse = { error: errorMsg };
      }
     
      if (!errorResponse?.limitReached) {
        const errorType = isOpenAIError ? "⚠️ ERROR CRÍTICO: OpenAI" : "❌ Error en análisis";
        const stackTrace = e.stack ? `\n\nStack Trace:\n${e.stack}` : "";
        await sendAlert(
          errorType,
          `Ruta: /api/analyze\n` +
          `Error: ${errorMsg}\n` +
          `Tipo: ${isOpenAIError ? "OpenAI API" : "Backend"}\n` +
          `Fecha: ${new Date().toISOString()}${stackTrace}`
        );
      }
      res.status(500).json(errorResponse);
    } finally {
      if (req.file && req.file.path) {
        deleteFile(req.file.path);
      }
    }
  });

  app.post("/api/interest", async (req, res) => {
    const { plan, email, name } = req.body as { plan: string; email: string; name: string };
    const planLabel = plan === "pro" ? "Pro (5€/mes)" : plan === "agency" ? "Agencia (15€/mes)" : plan;
    const ts = new Date().toISOString();
    const message =
      `Nuevo interés en plan: ${planLabel}\n\n` +
      `Email : ${email || "desconocido"}\n` +
      `Nombre: ${name || "no proporcionado"}\n` +
      `Fecha : ${ts}\n`;
    await sendAlert(`Nuevo interés en premium — ${planLabel}`, message);
    console.log(`[Interest] ${email} → ${planLabel}`);
    res.json({ ok: true });
  });

  app.post("/api/stripe/create-checkout-session", ClerkExpressRequireAuth(), async (req: any, res) => {
    try {
      const clerkId = req.auth?.userId;
      if (!clerkId) return res.status(401).json({ error: "No autenticado" });

      const { priceId } = req.body as { priceId: string };
      if (!priceId) return res.status(400).json({ error: "priceId requerido" });

      const email = req.auth?.sessionClaims?.email as string | undefined;
      const url = await createCheckoutSession(priceId, clerkId, email);
      res.json({ url });
    } catch (err: any) {
      console.error("[Stripe] Error creando checkout session:", err.message);
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/test-env", (_req, res) => {
    const isClerkConfigured = !!process.env.VITE_CLERK_PUBLISHABLE_KEY && !!process.env.CLERK_SECRET_KEY;
    console.log('Checking Clerk config:', {
      publishable: !!process.env.VITE_CLERK_PUBLISHABLE_KEY,
      secret: !!process.env.CLERK_SECRET_KEY
    });
    res.json({ status: isClerkConfigured ? "OK" : "Variables missing" });
  });

  async function checkOpenAIBalance() {
    try {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        console.log("[HealthCheck] OPENAI_API_KEY no configurada");
        return;
      }

      const response = await fetch("https://api.openai.com/v1/billing/credit_grants", {
        headers: { Authorization: `Bearer ${apiKey}` },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Billing API: ${response.status} - ${text}`);
      }

      const data = (await response.json()) as any;
      const totalGrants = data.data?.[0]?.grant_amount ?? 0;
      const usedGrants = data.data?.[0]?.used_amount ?? 0;
      const remainingBalance = totalGrants - usedGrants;

      console.log(`[HealthCheck] Balance: $${remainingBalance.toFixed(2)} (Total: $${totalGrants.toFixed(2)}, Usado: $${usedGrants.toFixed(2)})`);

      if (remainingBalance < 5) {
        await sendAlert(
          "⚠️ ALERTA: Saldo bajo en OpenAI",
          `El saldo disponible es bajo:\n\n` +
          `Saldo restante: $${remainingBalance.toFixed(2)}\n` +
          `Total asignado: $${totalGrants.toFixed(2)}\n` +
          `Usado: $${usedGrants.toFixed(2)}\n` +
          `Fecha: ${new Date().toISOString()}\n\n` +
          `⚡ Acción recomendada: Añade más créditos a tu cuenta de OpenAI.`
        );
        console.warn("[HealthCheck] ⚠️ ALERTA: Saldo bajo en OpenAI");
      }
    } catch (err) {
      console.error("[HealthCheck] Error verificando balance de OpenAI:", err);
      await sendAlert(
        "❌ ERROR: No se pudo verificar el balance de OpenAI",
        `Error: ${err instanceof Error ? err.message : String(err)}\n` +
        `Fecha: ${new Date().toISOString()}\n\n` +
        `Verifica que OPENAI_API_KEY sea válida y tenga acceso a la Billing API.`
      );
    }
  }

  // setInterval(checkOpenAIBalance, 6 * 60 * 60 * 1000);
  // setTimeout(checkOpenAIBalance, 10 * 1000);

  return httpServer;
}


   



   
      
