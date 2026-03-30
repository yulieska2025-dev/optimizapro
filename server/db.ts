import Database from "better-sqlite3";
import path from "path";
import pkg from "pg";

const { Pool } = pkg;

export type User = {
  clerk_id: string;
  email: string | null;
  plan: string;
  analyses_count: number;
  last_analysis_date: string | null;
  created_at: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
};

// Use PostgreSQL only in production AND when DATABASE_URL is set
const usePostgres = process.env.NODE_ENV === "production" && !!process.env.DATABASE_URL;

let db: any = null;
let pool: any = null;

if (usePostgres) {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });

  (async () => {
    try {
      const client = await pool.connect();
      await client.query(`
        CREATE TABLE IF NOT EXISTS users (
          clerk_id TEXT PRIMARY KEY,
          email TEXT,
          plan TEXT DEFAULT 'free',
          analyses_count INTEGER DEFAULT 0,
          last_analysis_date TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT
        );
        CREATE TABLE IF NOT EXISTS ip_registrations (
          id SERIAL PRIMARY KEY,
          ip TEXT NOT NULL,
          clerk_id TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);
      client.release();
      console.log("[DB] PostgreSQL tables initialized");
    } catch (error: any) {
      console.error("[DB] Error initializing PostgreSQL tables:", error.message);
    }
  })();
} else {
  const dbPath = path.join(process.cwd(), "data.sqlite");
  db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      clerk_id TEXT PRIMARY KEY,
      email TEXT,
      plan TEXT DEFAULT 'free',
      analyses_count INTEGER DEFAULT 0,
      last_analysis_date DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS ip_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT NOT NULL,
      clerk_id TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  try { db.exec(`ALTER TABLE users ADD COLUMN stripe_customer_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT`); } catch {}

  console.log("[DB] SQLite database initialized");
}

export async function getOrCreateUser(clerkId: string, email?: string): Promise<User> {
  if (usePostgres) {
    const existing = await pool.query("SELECT * FROM users WHERE clerk_id = $1", [clerkId]);
    if (existing.rows[0]) return existing.rows[0];
    await pool.query("INSERT INTO users (clerk_id, email) VALUES ($1, $2)", [clerkId, email ?? null]);
    const result = await pool.query("SELECT * FROM users WHERE clerk_id = $1", [clerkId]);
    return result.rows[0];
  } else {
    const existing = db.prepare("SELECT * FROM users WHERE clerk_id = ?").get(clerkId) as User | undefined;
    if (existing) return existing;
    db.prepare("INSERT INTO users (clerk_id, email) VALUES (?, ?)").run(clerkId, email ?? null);
    return db.prepare("SELECT * FROM users WHERE clerk_id = ?").get(clerkId) as User;
  }
}

export async function resetMonthlyCountIfNeeded(user: User): Promise<User> {
  if (!user.last_analysis_date) return user;

  const lastDate = new Date(user.last_analysis_date);
  const now = new Date();
  const isDifferentMonth =
    lastDate.getFullYear() !== now.getFullYear() ||
    lastDate.getMonth() !== now.getMonth();

  if (!isDifferentMonth) return user;

  console.log(`[DB] Reiniciando contador mensual para ${user.clerk_id}`);
  if (usePostgres) {
    await pool.query(
      "UPDATE users SET analyses_count = 0, last_analysis_date = NULL WHERE clerk_id = $1",
      [user.clerk_id]
    );
  } else {
    db.prepare("UPDATE users SET analyses_count = 0, last_analysis_date = NULL WHERE clerk_id = ?").run(user.clerk_id);
  }
  return { ...user, analyses_count: 0, last_analysis_date: null };
}

export async function incrementAnalysisCount(clerkId: string): Promise<void> {
  if (usePostgres) {
    await pool.query(
      "UPDATE users SET analyses_count = analyses_count + 1, last_analysis_date = CURRENT_TIMESTAMP WHERE clerk_id = $1",
      [clerkId]
    );
  } else {
    db.prepare(
      "UPDATE users SET analyses_count = analyses_count + 1, last_analysis_date = CURRENT_TIMESTAMP WHERE clerk_id = ?"
    ).run(clerkId);
  }
}
export async function checkIpLimit(ip: string, limit: number = 3): Promise<boolean> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  if (usePostgres) {
    const result = await pool.query(
      "SELECT COUNT(*) as count FROM ip_registrations WHERE ip = $1 AND created_at > $2",
      [ip, thirtyDaysAgo]
    );
    return parseInt(result.rows[0].count) < limit;
  } else {
    const count = db.prepare(
      "SELECT COUNT(*) as count FROM ip_registrations WHERE ip = ? AND created_at > ?"
    ).get(ip, thirtyDaysAgo) as { count: number };
    return count.count < limit;
  }
}

export async function registerIp(ip: string, clerkId: string): Promise<void> {
  if (usePostgres) {
    await pool.query("INSERT INTO ip_registrations (ip, clerk_id) VALUES ($1, $2)", [ip, clerkId]);
  } else {
    db.prepare("INSERT INTO ip_registrations (ip, clerk_id) VALUES (?, ?)").run(ip, clerkId);
  }
}

export async function updateUserPlan(
  clerkId: string,
  plan: string,
  stripeCustomerId?: string,
  stripeSubscriptionId?: string
): Promise<void> {
  if (usePostgres) {
    await pool.query(
      `UPDATE users SET plan = $1, stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id) WHERE clerk_id = $4`,
      [plan, stripeCustomerId ?? null, stripeSubscriptionId ?? null, clerkId]
    );
  } else {
    db.prepare(
      `UPDATE users SET plan = ?, stripe_customer_id = COALESCE(?, stripe_customer_id), stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE clerk_id = ?`
    ).run(plan, stripeCustomerId ?? null, stripeSubscriptionId ?? null, clerkId);
  }
  console.log(`[DB] Usuario ${clerkId} actualizado a plan ${plan}`);
}

// Nueva función: actualiza el plan y resetea el contador a 0
export async function setUserPlanAndResetCount(
  clerkId: string,
  plan: string,
  stripeCustomerId?: string,
  stripeSubscriptionId?: string
): Promise<void> {
  if (usePostgres) {
    await pool.query(
      `UPDATE users SET plan = $1, analyses_count = 0, last_analysis_date = CURRENT_TIMESTAMP,
       stripe_customer_id = COALESCE($2, stripe_customer_id),
       stripe_subscription_id = COALESCE($3, stripe_subscription_id)
       WHERE clerk_id = $4`,
      [plan, stripeCustomerId ?? null, stripeSubscriptionId ?? null, clerkId]
    );
  } else {
    db.prepare(
      `UPDATE users SET plan = ?, analyses_count = 0, last_analysis_date = CURRENT_TIMESTAMP,
       stripe_customer_id = COALESCE(?, stripe_customer_id),
       stripe_subscription_id = COALESCE(?, stripe_subscription_id)
       WHERE clerk_id = ?`
    ).run(plan, stripeCustomerId ?? null, stripeSubscriptionId ?? null, clerkId);
  }
  console.log(`[DB] Usuario ${clerkId} actualizado a plan ${plan} con contador reiniciado a 0`);
}

export async function getUserByStripeCustomerId(stripeCustomerId: string): Promise<User | undefined> {
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM users WHERE stripe_customer_id = $1", [stripeCustomerId]);
    return result.rows[0];
  } else {
    return db.prepare("SELECT * FROM users WHERE stripe_customer_id = ?").get(stripeCustomerId) as User | undefined;
  }
}

export async function getUserByStripeSubscriptionId(stripeSubscriptionId: string): Promise<User | undefined> {
  if (usePostgres) {
    const result = await pool.query("SELECT * FROM users WHERE stripe_subscription_id = $1", [stripeSubscriptionId]);
    return result.rows[0];
  } else {
    return db.prepare("SELECT * FROM users WHERE stripe_subscription_id = ?").get(stripeSubscriptionId) as User | undefined;
  }
}

export default db;


