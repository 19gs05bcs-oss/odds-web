import "server-only";
import dns from "node:dns";
import net from "node:net";
import postgres from "postgres";

// Railway'in container network'ü IPv6 egress desteklemiyor. dns.setDefaultResultOrder
// ve net.setDefaultAutoSelectFamily(false) denendi ama hostname'in AAAA (IPv6) kaydı
// tercih edilmeye devam etti — muhtemelen bu pooler hostname IPv6-öncelikli anycast
// döndürüyor. Kesin çözüm: DNS'i burada MANUEL çözüp, SADECE IPv4 (family: 4) sonucu
// kabul ederek, postgres.js'e ham TCP soketi doğrudan biz açıp veriyoruz. Böylece
// hangi adresin kullanılacağı konusunda Node'a hiç seçim bırakmıyoruz.
dns.setDefaultResultOrder("ipv4first");

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
  // postgres.js'in kendi DNS/soket açma mantığını bypass ediyoruz — hostname'i
  // burada family:4 zorlayarak çözüp, ham net.Socket'i doğrudan biz açıp
  // veriyoruz. SSL upgrade'ini postgres.js zaten bu ham soketin üzerinde kendi
  // yapıyor. NOT: runtime'da desteklenen bir seçenek ama kurulu postgres@3.4.9
  // paketinin .d.ts'i bunu tanımıyor (bkz. node_modules/postgres/src/connection.js:132-133,345)
  // — o yüzden ts-expect-error gerekiyor, gerçek bir hata değil.
  // @ts-expect-error - `socket` runtime'da var, bu sürümün type tanımlarında yok
  socket: ({ host, port }: { host: string[]; port: number[] }) =>
    new Promise((resolve, reject) => {
      const targetHost = host[0];
      const targetPort = port[0];
      dns.lookup(targetHost, { family: 4 }, (err, address) => {
        if (err) {
          console.error(
            `[db] IPv4 (A kaydı) çözümlenemedi (${targetHost}): ${err.message}. ` +
              `Bu hostname için gerçekten IPv4 adresi yok gibi görünüyor — Supabase ` +
              `dashboard'dan farklı bir pooler endpoint'i / IPv4 add-on gerekebilir.`,
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
