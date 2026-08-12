import { Hero } from "@/components/Hero";
import { PricingSection } from "@/components/PricingSection";
import { ProductDemo } from "@/components/ProductDemo";
import { SiteHeader } from "@/components/SiteHeader";

export default function HomePage() {
  return (
    <>
      <SiteHeader active="home" />
      <main>
        <Hero />
        <ProductDemo />
        <PricingSection />
      </main>
    </>
  );
}
