import postgres from "postgres";

// Supabase Transaction Pooler URL'ini environment değişkenlerinden okuyoruz
const connectionString = process.env.DATABASE_URL!;

// Supavisor pooler (6543) kullandığımız için prepare: false şart
export const sql = postgres(connectionString, {
  prepare: false,
  ssl: "require",
});
