/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // img uyarısı build'i düşürmesin; lint CI'da ayrı çalıştırılabilir
    ignoreDuringBuilds: true,
  },
  // DuckDB native binding'leri (.node dosyaları) webpack tarafından
  // parse edilemiyor. Bu paketleri bundle'lamak yerine runtime'da
  // normal Node.js require() ile yüklenmeleri için external bırakıyoruz.
  experimental: {
    serverComponentsExternalPackages: [
      "@duckdb/node-api",
      "@duckdb/node-bindings",
    ],
  },
  // www.oddsvig.com -> oddsvig.com (apex) kalıcı yönlendirme.
  // ÖNEMLİ: Bu redirect sadece apex domain (oddsvig.com) Railway'de
  // custom domain olarak eklenip DNS'i Railway'e işaret ettikten SONRA
  // işe yarar. Şu an apex Natro'nun parking sayfasında olduğu için
  // bu kural devreye girmiyor — apex DNS düzeltilmeden bu no-op'tur.
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.oddsvig.com" }],
        destination: "https://oddsvig.com/:path*",
        permanent: true,
      },
    ];
  },
};

export default nextConfig;
