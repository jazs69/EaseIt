import { ArrowRight, CalendarCheck } from 'lucide-react';

import { AmbientGlow, CtaButton, GradientText } from './primitives';

export function FinalCta() {
  return (
    <section
      id="get-started"
      className="relative isolate overflow-hidden px-4 py-24 sm:px-6 lg:px-8"
    >
      <AmbientGlow at="50% 100%" rgb="59 130 246" opacity={0.22} />
      <AmbientGlow at="20% 80%" rgb="168 85 247" opacity={0.12} />

      <div className="mx-auto flex max-w-3xl flex-col items-center gap-8 text-center">
        <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-5xl">
          Ready to put your front desk on{' '}
          <GradientText className="font-serif italic">autopilot?</GradientText>
        </h2>

        <p className="max-w-xl text-base leading-relaxed text-zinc-400">
          Migrate one property this week and run it alongside your current PMS. If the night audit
          totals do not reconcile to the paisa, you owe us nothing.
        </p>

        <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
          <CtaButton href="#trial" icon={ArrowRight} iconTrailing className="w-full sm:w-auto">
            Start Free Trial
          </CtaButton>
          <CtaButton
            href="#demo-call"
            variant="secondary"
            icon={CalendarCheck}
            className="w-full sm:w-auto"
          >
            Book a Demo
          </CtaButton>
        </div>

        <p className="text-xs text-zinc-600">
          No card required · 30-day trial · Migration assistance included
        </p>
      </div>
    </section>
  );
}
