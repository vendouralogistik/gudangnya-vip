const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(cors({
  origin: true,
  credentials: false
}));
app.use(express.json({ limit: "1mb" }));

const isProduction = process.env.NODE_ENV === "production";
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.warn("WARNING: DATABASE_URL belum diset.");
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: databaseUrl && /supabase\.(co|com)/i.test(databaseUrl)
    ? { rejectUnauthorized: false }
    : (isProduction ? { rejectUnauthorized: false } : false),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
});

const SESSION_SECRET = process.env.SESSION_SECRET || "ganti-session-secret-anda-di-vercel";
const TOKEN_TTL_SECONDS = 12 * 60 * 60;

function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(body)
    .digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [body, signature] = parts;
  const expected = crypto
    .createHmac("sha256", SESSION_SECRET)
    .update(body)
    .digest("base64url");

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ error: "Sesi tidak valid atau sudah kedaluwarsa. Silakan login kembali." });
  }
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Akses hanya untuk administrator." });
  }
  next();
}

function cleanString(value, max = 255) {
  return String(value ?? "").trim().slice(0, max);
}

function positiveNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function initDb() {
  if (!databaseUrl) throw new Error("DATABASE_URL belum diset.");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(100) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name VARCHAR(150) NOT NULL,
      role VARCHAR(30) NOT NULL DEFAULT 'staff',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS items (
      id BIGSERIAL PRIMARY KEY,
      code VARCHAR(80) NOT NULL UNIQUE,
      name VARCHAR(200) NOT NULL,
      category VARCHAR(100) NOT NULL DEFAULT '',
      unit VARCHAR(50) NOT NULL DEFAULT 'Pcs',
      min_stock NUMERIC(14,2) NOT NULL DEFAULT 0,
      current_stock NUMERIC(14,2) NOT NULL DEFAULT 0,
      location VARCHAR(120) NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_in (
      id BIGSERIAL PRIMARY KEY,
      item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
      quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
      reference_no VARCHAR(120) NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS stock_out (
      id BIGSERIAL PRIMARY KEY,
      item_id BIGINT NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
      quantity NUMERIC(14,2) NOT NULL CHECK (quantity > 0),
      reference_no VARCHAR(120) NOT NULL DEFAULT '',
      destination VARCHAR(150) NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_items_name ON items(name);
    CREATE INDEX IF NOT EXISTS idx_stock_in_item ON stock_in(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_out_item ON stock_out(item_id);
    CREATE INDEX IF NOT EXISTS idx_stock_in_created ON stock_in(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_stock_out_created ON stock_out(created_at DESC);
  `);

  const countResult = await pool.query("SELECT COUNT(*)::int AS count FROM items");
  if (countResult.rows[0].count === 0) {
    await autoSeed();
  }
}

async function autoSeed() {
  const filePath = path.join(__dirname, "data-gudang-vip.json");
  if (!fs.existsSync(filePath)) {
    console.warn("data-gudang-vip.json tidak ditemukan; database dibiarkan kosong.");
    return;
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (data.admin?.username && data.admin?.password) {
      const passwordHash = await bcrypt.hash(String(data.admin.password), 12);
      await client.query(
        `INSERT INTO users (username, password_hash, name, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (username) DO NOTHING`,
        [
          cleanString(data.admin.username, 100),
          passwordHash,
          cleanString(data.admin.name || "Administrator", 150),
          cleanString(data.admin.role || "admin", 30)
        ]
      );
    }

    const items = Array.isArray(data.items) ? data.items : [];
    for (const item of items) {
      const code = cleanString(item.code, 80);
      const name = cleanString(item.name, 200);
      if (!code || !name) continue;

      await client.query(
        `INSERT INTO items
          (code, name, category, unit, min_stock, current_stock, location)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (code) DO NOTHING`,
        [
          code,
          name,
          cleanString(item.category || "", 100),
          cleanString(item.unit || "Pcs", 50),
          Number(item.min_stock || 0),
          Number(item.initial_stock || 0),
          cleanString(item.location || "", 120)
        ]
      );
    }

    await client.query("COMMIT");
    console.log(`Auto-seed selesai: ${items.length} item diproses.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "Gudang VIP", time: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: "Database tidak dapat diakses." });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    // Menyebutkan nama kolom langsung untuk menghindari kesalahan sintaks '*'
    const result = await pool.query(
      'SELECT id, nama, email, password, role FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Email atau password salah.' });
    }

    const isMatch = bcrypt.compareSync(password, user.password);

    if (!isMatch) {
      return res.status(400).json({ error: 'Email atau password salah.' });
    }

    res.json({
      user: {
        id: user.id,
        name: user.nama,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/sync", auth, async (req, res) => {
  try {
    const [items, stockIn, stockOut, stats] = await Promise.all([
      pool.query(`
        SELECT id, code, name, category, unit, min_stock, current_stock, location,
               created_at, updated_at
        FROM items
        ORDER BY name ASC
      `),
      pool.query(`
        SELECT si.id, si.item_id, i.code, i.name, i.unit, si.quantity,
               si.reference_no, si.notes, si.created_at,
               u.name AS created_by_name
        FROM stock_in si
        JOIN items i ON i.id = si.item_id
        LEFT JOIN users u ON u.id = si.created_by
        ORDER BY si.created_at DESC
        LIMIT 100
      `),
      pool.query(`
        SELECT so.id, so.item_id, i.code, i.name, i.unit, so.quantity,
               so.reference_no, so.destination, so.notes, so.created_at,
               u.name AS created_by_name
        FROM stock_out so
        JOIN items i ON i.id = so.item_id
        LEFT JOIN users u ON u.id = so.created_by
        ORDER BY so.created_at DESC
        LIMIT 100
      `),
      pool.query(`
        SELECT
          (SELECT COUNT(*) FROM items)::int AS total_items,
          (SELECT COUNT(*) FROM items WHERE current_stock <= min_stock)::int AS critical_items,
          COALESCE((SELECT SUM(current_stock) FROM items), 0) AS total_units,
          COALESCE((SELECT SUM(quantity) FROM stock_in WHERE created_at >= NOW() - INTERVAL '30 days'), 0) AS inbound_30d,
          COALESCE((SELECT SUM(quantity) FROM stock_out WHERE created_at >= NOW() - INTERVAL '30 days'), 0) AS outbound_30d
      `)
    ]);

    res.json({
      server_time: new Date().toISOString(),
      items: items.rows,
      stock_in: stockIn.rows,
      stock_out: stockOut.rows,
      stats: stats.rows[0]
    });
  } catch (error) {
    console.error("Sync error:", error);
    res.status(500).json({ error: "Gagal mengambil data sinkronisasi." });
  }
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    // Query SQL yang sudah dipastikan valid untuk PostgreSQL
    const result = await pool.query(
      'SELECT * FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );
    const user = result.rows[0];

    if (!user) {
      return res.status(400).json({ error: 'Email atau password salah.' });
    }

    // Mendukung baik kolom 'password' maupun 'password_hash'
    const storedPassword = user.password || user.password_hash;
    const isMatch = bcrypt.compareSync(password, storedPassword);

    if (!isMatch) {
      return res.status(400).json({ error: 'Email atau password salah.' });
    }

    res.json({
      user: {
        id: user.id,
        name: user.nama,
        role: user.role
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: err.message });
  }
});
app.put("/api/items/:id", auth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const code = cleanString(req.body.code, 80);
    const name = cleanString(req.body.name, 200);
    const category = cleanString(req.body.category, 100);
    const unit = cleanString(req.body.unit || "Pcs", 50);
    const location = cleanString(req.body.location, 120);
    const minStock = Number(req.body.min_stock);

    if (!Number.isInteger(id) || id <= 0 || !code || !name ||
        !Number.isFinite(minStock) || minStock < 0) {
      return res.status(400).json({ error: "Data sparepart tidak valid." });
    }

    const result = await pool.query(
      `UPDATE items
       SET code = $1, name = $2, category = $3, unit = $4,
           min_stock = $5, location = $6, updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [code, name, category, unit, minStock, location, id]
    );

    if (!result.rowCount) return res.status(404).json({ error: "Sparepart tidak ditemukan." });
    res.json(result.rows[0]);
  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ error: "Kode sparepart sudah digunakan." });
    }
    console.error("Update item error:", error);
    res.status(500).json({ error: "Gagal memperbarui sparepart." });
  }
});

app.delete("/api/items/:id", auth, requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "ID sparepart tidak valid." });
    }

    await pool.query("DELETE FROM items WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (error) {
    if (error.code === "23503") {
      return res.status(409).json({
        error: "Sparepart sudah memiliki riwayat transaksi sehingga tidak dapat dihapus."
      });
    }
    console.error("Delete item error:", error);
    res.status(500).json({ error: "Gagal menghapus sparepart." });
  }
});

app.post("/api/stock-in", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const itemId = Number(req.body.item_id);
    const quantity = positiveNumber(req.body.quantity);
    const referenceNo = cleanString(req.body.reference_no, 120);
    const notes = cleanString(req.body.notes, 2000);

    if (!Number.isInteger(itemId) || itemId <= 0 || !quantity) {
      return res.status(400).json({ error: "Item dan jumlah stok masuk wajib valid." });
    }

    await client.query("BEGIN");

    const itemResult = await client.query(
      "SELECT id, code, name, current_stock FROM items WHERE id = $1 FOR UPDATE",
      [itemId]
    );
    if (!itemResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sparepart tidak ditemukan." });
    }

    await client.query(
      `INSERT INTO stock_in
       (item_id, quantity, reference_no, notes, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [itemId, quantity, referenceNo, notes, Number(req.user.sub)]
    );

    const updated = await client.query(
      `UPDATE items
       SET current_stock = current_stock + $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [quantity, itemId]
    );

    await client.query("COMMIT");
    res.status(201).json({ ok: true, item: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Stock-in error:", error);
    res.status(500).json({ error: "Gagal menyimpan transaksi stok masuk." });
  } finally {
    client.release();
  }
});

app.post("/api/stock-out", auth, async (req, res) => {
  const client = await pool.connect();
  try {
    const itemId = Number(req.body.item_id);
    const quantity = positiveNumber(req.body.quantity);
    const referenceNo = cleanString(req.body.reference_no, 120);
    const destination = cleanString(req.body.destination, 150);
    const notes = cleanString(req.body.notes, 2000);

    if (!Number.isInteger(itemId) || itemId <= 0 || !quantity) {
      return res.status(400).json({ error: "Item dan jumlah stok keluar wajib valid." });
    }

    await client.query("BEGIN");

    const itemResult = await client.query(
      `SELECT id, code, name, unit, current_stock
       FROM items WHERE id = $1 FOR UPDATE`,
      [itemId]
    );

    if (!itemResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Sparepart tidak ditemukan." });
    }

    const item = itemResult.rows[0];
    const available = Number(item.current_stock);
    if (quantity > available) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: `Stok tidak cukup. ${item.code} - ${item.name} tersedia ${available} ${item.unit}, sedangkan permintaan ${quantity} ${item.unit}.`
      });
    }

    await client.query(
      `INSERT INTO stock_out
       (item_id, quantity, reference_no, destination, notes, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [itemId, quantity, referenceNo, destination, notes, Number(req.user.sub)]
    );

    const updated = await client.query(
      `UPDATE items
       SET current_stock = current_stock - $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [quantity, itemId]
    );

    await client.query("COMMIT");
    res.status(201).json({ ok: true, item: updated.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Stock-out error:", error);
    res.status(500).json({ error: "Gagal menyimpan transaksi stok keluar." });
  } finally {
    client.release();
  }
});

app.get("/api/transactions", auth, async (req, res) => {
  try {
    const type = req.query.type === "out" ? "out" : "in";
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
    const table = type === "out" ? "stock_out" : "stock_in";
    const extra = type === "out" ? ", destination" : "";

    const result = await pool.query(
      `SELECT t.*, i.code, i.name, i.unit, u.name AS created_by_name
       FROM ${table} t
       JOIN items i ON i.id = t.item_id
       LEFT JOIN users u ON u.id = t.created_by
       ORDER BY t.created_at DESC
       LIMIT $1`,
      [limit]
    );

    res.json(result.rows);
  } catch (error) {
    console.error("Transactions error:", error);
    res.status(500).json({ error: "Gagal mengambil transaksi." });
  }
});


app.get("/api/reports/excel", auth, async (req, res) => {
  try {
    const from = cleanString(req.query.from, 10);
    const to = cleanString(req.query.to, 10);

    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value);
    if (!validDate(from) || !validDate(to)) {
      return res.status(400).json({ error: "Tanggal mulai dan tanggal akhir wajib valid." });
    }

    if (from > to) {
      return res.status(400).json({ error: "Tanggal mulai tidak boleh lebih besar dari tanggal akhir." });
    }

    const [itemsResult, inResult, outResult] = await Promise.all([
      pool.query(`
        SELECT id, code, name, category, unit, min_stock, current_stock, location
        FROM items
        ORDER BY name ASC
      `),
      pool.query(`
        SELECT si.id, si.created_at, i.code, i.name, i.category, i.unit,
               si.quantity, si.reference_no, si.notes, u.name AS created_by_name
        FROM stock_in si
        JOIN items i ON i.id = si.item_id
        LEFT JOIN users u ON u.id = si.created_by
        WHERE si.created_at >= $1::date
          AND si.created_at < ($2::date + INTERVAL '1 day')
        ORDER BY si.created_at ASC
      `, [from, to]),
      pool.query(`
        SELECT so.id, so.created_at, i.code, i.name, i.category, i.unit,
               so.quantity, so.reference_no, so.destination, so.notes,
               u.name AS created_by_name
        FROM stock_out so
        JOIN items i ON i.id = so.item_id
        LEFT JOIN users u ON u.id = so.created_by
        WHERE so.created_at >= $1::date
          AND so.created_at < ($2::date + INTERVAL '1 day')
        ORDER BY so.created_at ASC
      `, [from, to])
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Gudang VIP — PT. VENDOURA INTI PERKASA";
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.properties.subject = `Laporan Gudang ${from} s/d ${to}`;
    workbook.properties.title = "Laporan Gudang VIP";

    const titleFill = { type: "pattern", pattern: "solid", fgColor: { argb: "0F172A" } };
    const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "E2E8F0" } };
    const criticalFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FEF3C7" } };
    const whiteFont = { color: { argb: "FFFFFF" }, bold: true, size: 14 };
    const headerFont = { bold: true, color: { argb: "334155" } };

    function styleTitle(ws, title, subtitle, columnCount) {
      ws.mergeCells(1, 1, 1, columnCount);
      ws.getCell(1, 1).value = title;
      ws.getCell(1, 1).fill = titleFill;
      ws.getCell(1, 1).font = whiteFont;
      ws.getCell(1, 1).alignment = { vertical: "middle", horizontal: "left" };
      ws.getRow(1).height = 26;

      ws.mergeCells(2, 1, 2, columnCount);
      ws.getCell(2, 1).value = subtitle;
      ws.getCell(2, 1).font = { italic: true, color: { argb: "64748B" } };
      ws.getRow(2).height = 20;

      ws.views = [{ state: "frozen", ySplit: 3 }];
      ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: columnCount } };
    }

    function styleHeader(row) {
      row.eachCell(cell => {
        cell.fill = headerFill;
        cell.font = headerFont;
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        cell.border = {
          top: { style: "thin", color: { argb: "CBD5E1" } },
          bottom: { style: "thin", color: { argb: "CBD5E1" } }
        };
      });
      row.height = 24;
    }

    function setWidths(ws, widths) {
      widths.forEach((width, index) => {
        ws.getColumn(index + 1).width = width;
      });
    }

    // Ringkasan.
    const summary = workbook.addWorksheet("Ringkasan");
    summary.columns = [
      { header: "Metrik", key: "metric", width: 30 },
      { header: "Nilai", key: "value", width: 22 }
    ];
    styleTitle(summary, "LAPORAN GUDANG VIP", `Periode ${from} s/d ${to} • PT. VENDOURA INTI PERKASA`, 2);
    const summaryRows = [
      ["Tanggal laporan", `${from} s/d ${to}`],
      ["Total jenis sparepart", itemsResult.rowCount],
      ["Total unit stok saat ini", itemsResult.rows.reduce((sum, x) => sum + Number(x.current_stock || 0), 0)],
      ["Jumlah item stok kritis", itemsResult.rows.filter(x => Number(x.current_stock) <= Number(x.min_stock)).length],
      ["Total stok masuk periode", inResult.rows.reduce((sum, x) => sum + Number(x.quantity || 0), 0)],
      ["Total stok keluar periode", outResult.rows.reduce((sum, x) => sum + Number(x.quantity || 0), 0)],
      ["Jumlah transaksi masuk", inResult.rowCount],
      ["Jumlah transaksi keluar", outResult.rowCount],
      ["Dibuat pada", new Date().toLocaleString("id-ID")]
    ];
    summaryRows.forEach(row => summary.addRow(row));
    summary.getRow(3).values = ["Metrik", "Nilai"];
    styleHeader(summary.getRow(3));
    summaryRows.forEach((_, idx) => {
      const row = summary.getRow(4 + idx);
      row.getCell(2).numFmt = "#,##0.##";
    });
    summary.getCell(4, 2).numFmt = "@";
    summary.getCell(12, 2).numFmt = "@";
    summary.views = [{ state: "frozen", ySplit: 3 }];

    // Posisi stok.
    const stock = workbook.addWorksheet("Posisi Stok");
    styleTitle(stock, "POSISI STOK", `Kondisi stok saat laporan dibuat • ${from} s/d ${to}`, 8);
    stock.addRow(["Kode", "Nama Sparepart", "Kategori", "Unit", "Stok Saat Ini", "Minimum", "Status", "Lokasi"]);
    styleHeader(stock.getRow(3));
    for (const item of itemsResult.rows) {
      const current = Number(item.current_stock || 0);
      const min = Number(item.min_stock || 0);
      const row = stock.addRow([
        item.code, item.name, item.category, item.unit, current, min,
        current <= min ? "KRITIS" : "AMAN", item.location
      ]);
      row.getCell(5).numFmt = "#,##0.##";
      row.getCell(6).numFmt = "#,##0.##";
      if (current <= min) {
        row.eachCell(cell => { cell.fill = criticalFill; });
        row.getCell(7).font = { bold: true };
      }
    }
    setWidths(stock, [16, 32, 18, 12, 16, 14, 14, 18]);

    // Stok masuk.
    const inbound = workbook.addWorksheet("Stok Masuk");
    styleTitle(inbound, "TRANSAKSI STOK MASUK", `Periode ${from} s/d ${to}`, 10);
    inbound.addRow(["Tanggal", "Kode", "Nama Sparepart", "Kategori", "Unit", "Jumlah", "No. Referensi", "Catatan", "Dibuat Oleh", "ID"]);
    styleHeader(inbound.getRow(3));
    for (const x of inResult.rows) {
      const row = inbound.addRow([
        new Date(x.created_at), x.code, x.name, x.category, x.unit, Number(x.quantity),
        x.reference_no, x.notes, x.created_by_name || "-", x.id
      ]);
      row.getCell(1).numFmt = "dd/mm/yyyy hh:mm";
      row.getCell(6).numFmt = "#,##0.##";
    }
    setWidths(inbound, [20, 16, 32, 18, 12, 14, 22, 34, 24, 10]);

    // Stok keluar.
    const outbound = workbook.addWorksheet("Stok Keluar");
    styleTitle(outbound, "TRANSAKSI STOK KELUAR", `Periode ${from} s/d ${to}`, 11);
    outbound.addRow(["Tanggal", "Kode", "Nama Sparepart", "Kategori", "Unit", "Jumlah", "No. Referensi", "Tujuan", "Catatan", "Dibuat Oleh", "ID"]);
    styleHeader(outbound.getRow(3));
    for (const x of outResult.rows) {
      const row = outbound.addRow([
        new Date(x.created_at), x.code, x.name, x.category, x.unit, Number(x.quantity),
        x.reference_no, x.destination, x.notes, x.created_by_name || "-", x.id
      ]);
      row.getCell(1).numFmt = "dd/mm/yyyy hh:mm";
      row.getCell(6).numFmt = "#,##0.##";
    }
    setWidths(outbound, [20, 16, 32, 18, 12, 14, 22, 24, 34, 24, 10]);

    // Rekap per item.
    const recap = workbook.addWorksheet("Rekap Per Item");
    styleTitle(recap, "REKAP PER SPAREPART", `Pergerakan stok selama ${from} s/d ${to}`, 10);
    recap.addRow(["Kode", "Nama Sparepart", "Kategori", "Unit", "Stok Awal*", "Masuk", "Keluar", "Stok Saat Ini", "Minimum", "Status"]);
    styleHeader(recap.getRow(3));

    const movement = new Map();
    for (const x of inResult.rows) {
      const key = String(x.code);
      const cur = movement.get(key) || { in: 0, out: 0 };
      cur.in += Number(x.quantity || 0);
      movement.set(key, cur);
    }
    for (const x of outResult.rows) {
      const key = String(x.code);
      const cur = movement.get(key) || { in: 0, out: 0 };
      cur.out += Number(x.quantity || 0);
      movement.set(key, cur);
    }

    for (const item of itemsResult.rows) {
      const mv = movement.get(String(item.code)) || { in: 0, out: 0 };
      const current = Number(item.current_stock || 0);
      const opening = current - mv.in + mv.out;
      const min = Number(item.min_stock || 0);
      const row = recap.addRow([
        item.code, item.name, item.category, item.unit, opening, mv.in, mv.out,
        current, min, current <= min ? "KRITIS" : "AMAN"
      ]);
      for (let c = 5; c <= 9; c++) row.getCell(c).numFmt = "#,##0.##";
      if (current <= min) row.getCell(10).font = { bold: true };
    }
    setWidths(recap, [16, 32, 18, 12, 16, 14, 14, 16, 14, 14]);
    recap.addRow(["* Stok Awal dihitung berdasarkan stok saat ini dikurangi/ditambah transaksi pada periode laporan."]);

    for (const ws of workbook.worksheets) {
      ws.eachRow(row => {
        row.eachCell(cell => {
          cell.alignment = { ...(cell.alignment || {}), vertical: "middle", wrapText: true };
        });
      });
      ws.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9
      };
      ws.pageMargins = { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
      ws.headerFooter.oddFooter = "Gudang VIP • PT. VENDOURA INTI PERKASA • Halaman &P dari &N";
    }

    const buffer = await workbook.xlsx.writeBuffer();
    const filename = `Laporan-Gudang-VIP-${from}-sd-${to}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(Buffer.from(buffer));
  } catch (error) {
    console.error("Excel report error:", error);
    res.status(500).json({ error: "Gagal membuat laporan Excel." });
  }
});

app.get("/api/users", auth, requireAdmin, async (req, res) => {
  const result = await pool.query(
    "SELECT id, username, name, role, created_at FROM users ORDER BY name"
  );
  res.json(result.rows);
});

app.use("/api", (req, res) => {
  res.status(404).json({ error: "Endpoint API tidak ditemukan." });
});

app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

let dbReady = false;
let dbInitPromise = null;

async function ensureDb() {
  if (dbReady) return;
  if (!dbInitPromise) {
    dbInitPromise = initDb()
      .then(() => {
        dbReady = true;
      })
      .finally(() => {
        dbInitPromise = null;
      });
  }
  await dbInitPromise;
}

app.use(async (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    try {
      await ensureDb();
    } catch (error) {
      console.error("DB initialization error:", error);
      return res.status(500).json({
        error: "Database belum siap. Pastikan DATABASE_URL Supabase sudah benar."
      });
    }
  }
  next();
});
if (require.main === module) {
  const port = process.env.PORT || 3000;
  ensureDb()
    .then(() => {
      app.listen(port, () => {
        console.log(`Gudang VIP berjalan di http://localhost:${port}`);
      });
    })
    .catch((error) => {
      console.error("Gagal menyiapkan database:", error);
      process.exit(1);
    });
}

module.exports = app;
