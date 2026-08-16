import "server-only";
import dns from "node:dns";
import net from "node:net";
import postgres from "postgres";

// Railway'in container network'ü IPv6 egress desteklemiyor. Supabase pooler
// hostname'i hem A (IPv4) hem AAAA (IPv6) kaydı döndürüyor.
// 1) DNS sıralamasını IPv4-önce yap.
dns.setDefaultResultOrder("ipv4first");
// 2) Node 18.13+/20'de varsayılan açık olan "Happy Eyeballs" (autoSelectFamily)
//    algoritması, sıralama IPv4-önce olsa bile paralel/iç-içe denemelerle yine
//    IPv6 adresine dokunabiliyor ve "connect ENETUNREACH <ipv6>:6543" ile
//    patlıyor. Bunu tamamen kapatıp SADECE dns.lookup'ın döndürdüğü ilk
//    (artık IPv4) adresi kullanmaya zorluyoruz.
net.setDefaultAutoSelectFamily(false);

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
