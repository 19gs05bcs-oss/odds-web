/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    // img uyarısı build'i düşürmesin; lint CI'da ayrı çalıştırılabilir
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
