// scripts/stub-server-only.cjs
//
// "server-only" paketi, Next.js'in webpack/turbopack build sistemi DIŞINDA
// (düz `tsx`/`node` ile) HER ZAMAN throw ediyor (index.js koşulsuz throw
// ediyor, NODE_ENV kontrolü falan yok — gerçek npm paketinin kaynağı bu).
// Next.js normalde bu import'u kendi bundler'ında zararsız bir modülle
// alias'lıyor; standalone script'lerde bu alias yok.
//
// Bu dosya, Node'un CJS require mekanizmasına girip sadece "server-only"
// isteğini boş bir modülle karşılıyor — src/lib/db.ts VEYA başka hiçbir
// production dosyasına DOKUNMUYORUZ, guard prod build'de aynen duruyor.
//
// Kullanım (proje kökünden):
//   npx tsx -r ./scripts/stub-server-only.cjs scripts/test-similarity-single-bm.ts <eventId> <bookmaker>

const Module = require("module");
const originalLoad = Module._load;

Module._load = function (request, parent, isMain) {
  if (request === "server-only") {
    return {};
  }
  return originalLoad.apply(this, arguments);
};
