import type { MetadataRoute } from "next";

const SITE_URL = "https://oddsvig.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/account", "/auth/", "/login", "/matches", "/analyze", "/smart-analysis"],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
