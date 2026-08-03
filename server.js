const express = require("express");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// JWT_SECRET precisa ser configurado como variável de ambiente no Railway (Settings -> Variables).
// Se não for definido, o servidor gera um valor aleatório só para essa execução (todo mundo
// é deslogado a cada reinício) -- funciona para testar, mas defina uma variável fixa em produção.
const JWT_SECRET = process.env.JWT_SECRET || require("crypto").randomBytes(32).toString("hex");
const IS_PROD = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(express.static(__dirname));

const ROLES = ["admin", "comercial", "operacional"];

async function initDb() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin','comercial','operacional')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pricing_config (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL DEFAULT '{}',
      updated_by TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migração de continuidade: se existir o antigo app_state (versão anterior, sem login),
  // importa os dados de lá para as tabelas novas na primeira vez que o servidor novo sobe.
  const legacy = await pool.query("SELECT to_regclass('app_state') as exists");
  if (legacy.rows[0].exists) {
    const { rows } = await pool.query("SELECT clients, pricing_config FROM app_state WHERE id = 1");
    if (rows.length) {
      const clientCount = await pool.query("SELECT count(*) FROM clients");
      if (Number(clientCount.rows[0].count) === 0 && Array.isArray(rows[0].clients)) {
        for (const c of rows[0].clients) {
          await pool.query(
            "INSERT INTO clients (id, data, updated_by) VALUES ($1, $2, 'migração') ON CONFLICT (id) DO NOTHING",
            [c.id, JSON.stringify(c)]
          );
        }
        console.log(`Migrados ${rows[0].clients.length} clientes do app_state antigo.`);
      }
      const pricingCount = await pool.query("SELECT count(*) FROM pricing_config");
      if (Number(pricingCount.rows[0].count) === 0 && rows[0].pricing_config) {
        await pool.query("INSERT INTO pricing_config (id, data, updated_by) VALUES (1, $1, 'migração')", [
          JSON.stringify(rows[0].pricing_config),
        ]);
        console.log("Precificação migrada do app_state antigo.");
      }
    }
  }

  const pricingRow = await pool.query("SELECT id FROM pricing_config WHERE id = 1");
  if (pricingRow.rows.length === 0) {
    await pool.query("INSERT INTO pricing_config (id, data, updated_by) VALUES (1, '{}', 'sistema')");
  }
}

// ---- Autenticação ----

function setAuthCookie(res, user) {
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name, role: user.role }, JWT_SECRET, {
    expiresIn: "30d",
  });
  res.cookie("crm_token", token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies.crm_token;
  if (!token) return res.status(401).json({ error: "Não autenticado." });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Sessão inválida ou expirada." });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: "Você não tem permissão para fazer isso." });
    }
    next();
  };
}

// Primeiro acesso: cria a conta admin, só funciona se ainda não existir nenhum usuário.
app.post("/api/auth/setup", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password || password.length < 6) {
    return res.status(400).json({ error: "Preencha nome, e-mail e uma senha com pelo menos 6 caracteres." });
  }
  const { rows } = await pool.query("SELECT count(*) FROM users");
  if (Number(rows[0].count) > 0) {
    return res.status(403).json({ error: "Já existe uma conta configurada. Peça um convite ao administrador." });
  }
  const hash = await bcrypt.hash(password, 10);
  const result = await pool.query(
    "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,'admin') RETURNING id, email, name, role",
    [email.toLowerCase().trim(), hash, name.trim()]
  );
  setAuthCookie(res, result.rows[0]);
  res.json({ user: result.rows[0] });
});

app.get("/api/auth/needs-setup", async (req, res) => {
  const { rows } = await pool.query("SELECT count(*) FROM users");
  res.json({ needsSetup: Number(rows[0].count) === 0 });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [(email || "").toLowerCase().trim()]);
  if (rows.length === 0) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  const ok = await bcrypt.compare(password || "", rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: "E-mail ou senha incorretos." });
  const user = { id: rows[0].id, email: rows[0].email, name: rows[0].name, role: rows[0].role };
  setAuthCookie(res, user);
  res.json({ user });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("crm_token");
  res.json({ ok: true });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// Gestão de equipe (só admin)
app.get("/api/users", requireAuth, requireRole("admin"), async (req, res) => {
  const { rows } = await pool.query("SELECT id, email, name, role, created_at FROM users ORDER BY created_at");
  res.json({ users: rows });
});

app.post("/api/users", requireAuth, requireRole("admin"), async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 6 || !ROLES.includes(role)) {
    return res.status(400).json({ error: "Dados inválidos. Confira nome, e-mail, senha (6+ caracteres) e papel." });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      "INSERT INTO users (email, password_hash, name, role) VALUES ($1,$2,$3,$4) RETURNING id, email, name, role",
      [email.toLowerCase().trim(), hash, name.trim(), role]
    );
    res.json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Já existe uma conta com esse e-mail." });
    console.error(err);
    res.status(500).json({ error: "Não foi possível criar o usuário." });
  }
});

app.delete("/api/users/:id", requireAuth, requireRole("admin"), async (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "Você não pode remover sua própria conta." });
  await pool.query("DELETE FROM users WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Clientes (um registro por linha) ----

app.get("/api/clients", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT data FROM clients ORDER BY updated_at");
  res.json({ clients: rows.map((r) => r.data) });
});

// Upsert em lote -- comercial e admin podem criar/editar clientes e vendas.
app.put("/api/clients", requireAuth, requireRole("admin", "comercial"), async (req, res) => {
  const { clients } = req.body;
  if (!Array.isArray(clients)) return res.status(400).json({ error: "Formato inválido." });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const c of clients) {
      await client.query(
        `INSERT INTO clients (id, data, updated_by, updated_at) VALUES ($1,$2,$3, now())
         ON CONFLICT (id) DO UPDATE SET data = $2, updated_by = $3, updated_at = now()`,
        [c.id, JSON.stringify(c), req.user.email]
      );
    }
    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: "Não foi possível salvar os clientes." });
  } finally {
    client.release();
  }
});

// Caminho restrito para o time operacional: só pode mexer na etapa de integração de um cliente,
// nunca nos dados comerciais, valores ou cadastro.
app.put("/api/clients/:id/onboard-stage", requireAuth, requireRole("admin", "comercial", "operacional"), async (req, res) => {
  const { onboardStage } = req.body;
  const { rows } = await pool.query("SELECT data FROM clients WHERE id = $1", [req.params.id]);
  if (rows.length === 0) return res.status(404).json({ error: "Cliente não encontrado." });
  const updated = { ...rows[0].data, onboardStage };
  await pool.query("UPDATE clients SET data = $1, updated_by = $2, updated_at = now() WHERE id = $3", [
    JSON.stringify(updated),
    req.user.email,
    req.params.id,
  ]);
  res.json({ client: updated });
});

app.delete("/api/clients/:id", requireAuth, requireRole("admin"), async (req, res) => {
  await pool.query("DELETE FROM clients WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ---- Estrutura de precificação (sensível -- só admin e comercial visualizam, só admin edita) ----

app.get("/api/pricing", requireAuth, requireRole("admin", "comercial"), async (req, res) => {
  const { rows } = await pool.query("SELECT data FROM pricing_config WHERE id = 1");
  res.json({ pricingConfig: rows[0] ? rows[0].data : {} });
});

app.put("/api/pricing", requireAuth, requireRole("admin"), async (req, res) => {
  const { pricingConfig } = req.body;
  await pool.query(
    `INSERT INTO pricing_config (id, data, updated_by, updated_at) VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = $1, updated_by = $2, updated_at = now()`,
    [JSON.stringify(pricingConfig || {}), req.user.email]
  );
  res.json({ ok: true });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`CRM rodando na porta ${PORT}`));
  })
  .catch((err) => {
    console.error("Erro ao iniciar o banco de dados:", err);
    process.exit(1);
  });
