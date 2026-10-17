import { Comparison } from '@/components/landing/comparison';
import { FaqAccordion } from '@/components/landing/faq-accordion';
import { FeatureBento } from '@/components/landing/feature-bento';
import { FinalCta } from '@/components/landing/final-cta';
import { Hero } from '@/components/landing/hero';
import { PmsShowcase } from '@/components/landing/pms-showcase';
import { PortfolioMarquee } from '@/components/landing/portfolio-marquee';
import { HairlineDivider } from '@/components/landing/primitives';
import { SiteFooter } from '@/components/landing/site-footer';
import { SiteHeader } from '@/components/landing/site-header';

/**
 * EaseIt marketing landing page (yourdomain.com).
 *
 * Composition only — every section is a self-contained component under
 * components/landing. The page itself stays a server component; the two
 * sections that need state (the nav's mobile menu and the FAQ accordion) opt
 * into the client individually, so the rest ships zero JavaScript.
 */
export default function MarketingHomePage() {
  return (
    <>
      <SiteHeader />

      <main>
        <Hero />
        <PmsShowcase />

        <HairlineDivider />
        <PortfolioMarquee />
        <HairlineDivider />

        <FeatureBento />

        <HairlineDivider />
        <Comparison />
        <HairlineDivider />

        <FaqAccordion />
        <FinalCta />
      </main>

      <SiteFooter />
    </>
  );
}
