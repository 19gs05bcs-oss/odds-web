import "server-only";
import dns from "node:dns";
import net from "node:net";
import postgres from "postgres";

// similarityEngine.ts gibi ağır/uzun süren sorgular için AYRI bir connection.
// db.ts'deki paylaşılan `sql`, Supavisor TRANSACTION POOLER'ı (6543) kullanıyor
// — bu pooler uzun süren / büyük VALUES-join sorgularını (spreadQuery,
// driftQuery) kesip 502'ye yol açabiliyor (bkz. create-spread-index.ts'in
// neden DIRECT_DATABASE_URL istediğine dair not — CONCURRENTLY de aynı
// sebeple pooler'da güvenilir çalışmıyordu).
//
// Bu client SESSION/DIRECT bağlantı (5432) kullanır, pooler'ı tamamen bypass
// eder. Bilerek düşük bağlantı sayısıyla (max) sınırlı tutuluyor çünkü direct
// connection limiti pooler'a göre çok daha kısıtlı (Supabase planına göre
// genelde ~60-100).
//
// ÖNEMLİ: DIRECT_DATABASE_URL env değişkeni Railway'de tanımlı olmalı, portu
// 5432 olmalı (6543 DEĞİL). create-spread-index.ts scriptiyle aynı env var.
const connectionString = process.env.DIRECT_DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "[dbDirect] DIRECT_DATABASE_URL env değişkeni yok. Railway'de Supabase " +
      "'session pooler' veya 'direct connection' string'ini (port 5432) ekle.",
  );
}
if (connectionString.includes(":6543")) {
  throw new Error(
    "[dbDirect] DIRECT_DATABASE_URL 6543 (transaction pooler) portunu içeriyor — " +
      "bu değişken 5432 (direct/session) olmalı. DATABASE_URL ile karıştırılmış olabilir.",
  );
}

dns.setDefaultResultOrder("ipv4first");

// db.ts'deki ile birebir aynı — date/timestamp kolonlarını ham string
// bırakıyoruz, aksi halde React "Objects are not valid as a React child".
const stringifyDate = {
  to: 1184,
  from: [1082, 1114, 1184],
  serialize: (x: string) => x,
  parse: (x: string) => x,
};

export const sqlDirect = postgres(connectionString, {
  // Direct connection'da pgbouncer/pooler yok, prepared statements güvenli —
  // ama db.ts ile tutarlı davranış için yine de false bırakıyoruz.
  prepare: false,
  ssl: "require",
  max: 3,
  idle_timeout: 20,
  types: {
    date: stringifyDate,
  },
  // db.ts'deki IPv4-zorlama workaround'ının birebir aynısı — Railway'in
  // container network'ü IPv6 egress desteklemiyor.
  // @ts-expect-error - `socket` runtime'da var, postgres@3.4.9 type tanımlarında yok
  socket: ({ host, port }: { host: string[]; port: number[] }) =>
    new Promise((resolve, reject) => {
      const targetHost = host[0];
      const targetPort = port[0];
      dns.lookup(targetHost, { family: 4 }, (err, address) => {
        if (err) {
          console.error(
            `[dbDirect] IPv4 (A kaydı) çözümlenemedi (${targetHost}): ${err.message}.`,
          );
          reject(err);
          return;
        }
        const socket = net.connect({ host: address, port: targetPort });
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    }),
});
