import { Router } from "express";
import { pool } from "../db";
import { hashPassword, verifyPassword, issueAuthCookie, clearAuthCookie, requireAuth } from "../auth";
import { AuthRequestSchema } from "../schemas";

/**
 * 照抄 OPSL 的 routes/auth.ts,拿掉 role 欄位——前端登入彈窗沒有角色選擇 UI,
 * 不要求使用者填一個介面上不存在的欄位。
 */
export const authRouter = Router();

authRouter.post("/auth/register", async (req, res) => {
  const parsed = AuthRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "帳號或密碼格式錯誤", detail: parsed.error.flatten() });
  }
  const { username, password } = parsed.data;

  const existing = await pool.query(`SELECT id FROM users WHERE username = $1`, [username]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: "此帳號名稱已被使用" });
  }

  const passwordHash = await hashPassword(password);
  const result = await pool.query(
    `INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username`,
    [username, passwordHash]
  );
  const user = result.rows[0];
  issueAuthCookie(res, user.id);
  res.status(201).json(user);
});

authRouter.post("/auth/login", async (req, res) => {
  const parsed = AuthRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "請輸入帳號與密碼" });
  }
  const { username, password } = parsed.data;

  const result = await pool.query(`SELECT id, username, password_hash FROM users WHERE username = $1`, [
    username,
  ]);
  if (result.rows.length === 0) {
    return res.status(401).json({ error: "帳號或密碼錯誤" });
  }
  const user = result.rows[0];
  const passwordOk = await verifyPassword(password, user.password_hash);
  if (!passwordOk) {
    return res.status(401).json({ error: "帳號或密碼錯誤" });
  }

  issueAuthCookie(res, user.id);
  res.json({ id: user.id, username: user.username });
});

authRouter.post("/auth/logout", (_req, res) => {
  clearAuthCookie(res);
  res.status(204).end();
});

authRouter.get("/auth/me", requireAuth, async (req, res) => {
  const result = await pool.query(`SELECT id, username FROM users WHERE id = $1`, [req.userId]);
  if (result.rows.length === 0) return res.status(401).json({ error: "尚未登入" });
  res.json(result.rows[0]);
});
