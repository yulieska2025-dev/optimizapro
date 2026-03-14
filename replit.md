# OptimizaPro - Analizador de Campañas Facebook Ads

## Descripción
Aplicación web completa para el análisis de campañas de Facebook Ads con sistema freemium y alertas por email.

## Stack Técnico
- **Frontend**: React + TypeScript + Vite + TailwindCSS + shadcn/ui
- **Backend**: Node.js + Express + SQLite + Drizzle ORM
- **Autenticación**: Clerk
- **IA**: OpenAI GPT-4o Vision + GPT-3.5-turbo
- **Alertas**: Brevo (envío de emails)
- **Carga de archivos**: multer

## Características Principales
1. **Análisis de Campañas**: Sube imágenes de Facebook Ads o CSV con métricas
2. **Framework Andrómeda 2026**: Análisis estructurado con diagnosticp de Entity IDs
3. **Sistema Freemium**:
   - Plan Gratuito: 2 análisis/mes
   - Plan Pro: 5€/mes (50 análisis)
   - Plan Agencia: 15€/mes (ilimitados)
4. **Protección Anti-Abuso**: Límite de registros por IP (3 cuentas en 30 días)
5. **Alertas por Email**:
   - Errores críticos en análisis (OpenAI, rate limits, etc.)
   - Saldo bajo de OpenAI (chequeo cada 6 horas)
   - Nuevos usuarios que alcanzan límite freemium
   - Registro de interés en planes premium

## Rutas API Clave
- `POST /api/analyze` — Procesa imagen/CSV, detecta modelo GPT, incrementa contador freemium
- `GET /api/user/me` — Retorna plan, analyses_count, analysesLeft, email (requiere Clerk auth)
- `POST /api/interest` — Registra interés en plan premium, envía alert por email

## Sistema de Alertas (Brevo)
- **Trigger 1**: Errores en `/api/analyze` (OpenAI, backend)
- **Trigger 2**: Health check cada 6 horas — saldo de OpenAI < $5
- **Trigger 3**: Usuario gratuito alcanza límite de 2 análisis (métrica de conversión)
- **Trigger 4**: Nuevo interés en plan Pro/Agencia desde `/upgrade`

## Secrets Requeridos
- `CLERK_SECRET_KEY` — Autenticación de usuarios
- `OPENAI_API_KEY` — Modelos GPT-4o y GPT-3.5-turbo
- `BREVO_API_KEY` — Envío de alertas por email
- `ALERT_EMAIL` — Email destino para alertas (default: yulieska2025@gmail.com)
- `FROM_EMAIL` (opcional) — Email remitente (default: alertas@optimizapro.local)

## Estructura de Archivos Clave
- `client/src/pages/home.tsx` — Principal, upload, análisis, status dashboard
- `client/src/pages/upgrade.tsx` — Página de planes y pricing
- `server/routes.ts` — Rutas API, lógica de análisis, health checks
- `server/mailer.ts` — Integración Brevo para alertas
- `server/db.ts` — SQLite con freemium counter, IP tracking, user state
- `prompt_base.txt` — Prompt del framework Andrómeda 2026 (protegido)

## Inicio
```bash
npm run dev
```
