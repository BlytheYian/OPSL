import type { NextFunction, Request, Response } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "change-me-in-production";
const COOKIE_NAME = "yiyuanju_token";
const TOKEN_TTL = "30d";

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(password, passwordHash);
}

interface TokenPayload {
  userId: number;
}

export function issueAuthCookie(res: Response, userId: number) {
  const token = jwt.sign({ userId } satisfies TokenPayload, JWT_SECRET, { expiresIn: TOKEN_TTL });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(res: Response) {
  res.clearCookie(COOKIE_NAME);
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: number;
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "尚未登入" });
    return;
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET) as TokenPayload;
    req.userId = payload.userId;
    next();
  } catch {
    res.status(401).json({ error: "登入已逾期或無效,請重新登入" });
  }
}
