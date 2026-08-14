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
};

export default nextConfig;
