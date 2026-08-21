import type { Metadata } from "next";
import { Fraunces, Source_Sans_3 } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
  display: "swap",
});

const sourceSans = Source_Sans_3({
  variable: "--font-source-sans",
  subsets: ["latin"],
  display: "swap",
});

const SITE_URL = "https://oddsvig.com";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "OddsVig — Historical Odds Pattern Matching",
    template: "%s · OddsVig",
  },
  description:
    "OddsVig matches today's fixture odds against a multi-season archive using closing-price similarity, so you can see how games with the same odds shape actually closed.",
  keywords: [
    "odds pattern matching",
    "historical odds comparison",
    "closing odds archive",
    "find similar matches odds",
    "market odds profile search",
  ],
  icons: { icon: "/oddsvig.png" },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "OddsVig",
    title: "OddsVig — Historical Odds Pattern Matching",
    description:
      "Compare a fixture's odds against thousands of historical matches with the same closing-price shape.",
  },
  twitter: {
    card: "summary_large_image",
    title: "OddsVig — Historical Odds Pattern Matching",
    description:
      "Compare a fixture's odds against thousands of historical matches with the same closing-price shape.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${fraunces.variable} ${sourceSans.variable}`}>{children}</body>
    </html>
  );
}
