import { Pool, types } from "pg";

types.setTypeParser(1700, (value: string) => parseFloat(value));

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    "postgres://yiyuanju:yiyuanju@localhost:5432/yiyuanju",
});
