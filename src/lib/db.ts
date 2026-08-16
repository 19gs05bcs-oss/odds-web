import "server-only";
import postgres from "postgres";
// Supabase Transaction Pooler URL'ini environment değişkenlerinden okuyoruz
const connectionString = process.env.DATABASE_URL!;

// date/timestamp/timestamptz kolonlarını JS Date nesnesine çevirme —
// ham string olarak bırak (eski Supabase/PostgREST + JSON davranışıyla
// aynı). Aksi halde React "Objects are not valid as a React child"
// (Date) hatası veriyor, çünkü tüm frontend kodu string bekliyor.
const stringifyDate = {
  to: 1184,
  from: [1082, 1114, 1184], // date, timestamp, timestamptz
  serialize: (x: string) => x,
  parse: (x: string) => x,
};

// Supavisor pooler (6543) kullandığımız için prepare: false şart
export const sql = postgres(connectionString, {
  prepare: false,
  ssl: "require",
  types: {
    date: stringifyDate,
  },
});
