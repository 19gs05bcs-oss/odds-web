import type { MetadataRoute } from "next";

const SITE_URL = "https://oddsvig.com";

/**
 * /matches, /analyze, /smart-analysis middleware'de üyelik duvarı arkasında
 * (bkz. src/middleware.ts — MEMBER_PAGES / SMART_PAGES). Googlebot anonim
 * geldiği için bu rotalara girince /login'e yönlendiriliyor ve gerçek
 * içeriği hiç göremiyor. Bu yüzden sitemap'e SADECE gerçekten public olan,
 * login gerektirmeyen sayfaları koyuyoruz. Gated sayfalar için içerik
 * public hale gelmeden (teaser sayfa vb.) sitemap'e eklenmemeli.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: `${SITE_URL}/odds-guide`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.7,
    },
  ];
}
