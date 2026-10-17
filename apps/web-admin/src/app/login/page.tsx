import type { Metadata } from 'next';

import { SignInPanel } from '@/components/login/sign-in-panel';
import { ShowcasePanel } from '@/components/login/showcase-panel';
import { X } from 'lucide-react';

export const metadata: Metadata = {
  title: 'Log in',
  description: 'Staff sign-in for the EaseIt hotel operating system.',
  robots: { index: false, follow: false },
};

const MARKETING_URL = process.env.NEXT_PUBLIC_MARKETING_URL ?? 'http://localhost:3000';

/**
 * Blurred suggestion of the reservation grid behind the dialog.
 *
 * The reference design dims the real page behind its modal. A login route has
 * no page behind it, so rather than fake a dashboard — which would imply the
 * operator is already signed in — this renders abstract stay bars, blurred
 * past legibility. Decorative, so it is hidden from assistive tech and never
 * takes pointer events.
 */
function BackdropGrid() {
  const rows = [
    [
      { left: '2%', width: '18%', tone: 'bg-emerald-500' },
      { left: '26%', width: '30%', tone: 'bg-blue-500' },
      { left: '62%', width: '22%', tone: 'bg-blue-500' },
    ],
    [
      { left: '8%', width: '34%', tone: 'bg-blue-500' },
      { left: '50%', width: '16%', tone: 'bg-amber-500' },
      { left: '72%', width: '24%', tone: 'bg-emerald-500' },
    ],
    [
      { left: '0%', width: '24%', tone: 'bg-amber-500' },
      { left: '30%', width: '40%', tone: 'bg-emerald-500' },
      { left: '76%', width: '20%', tone: 'bg-blue-500' },
    ],
    [
      { left: '12%', width: '28%', tone: 'bg-blue-500' },
      { left: '46%', width: '26%', tone: 'bg-emerald-500' },
      { left: '80%', width: '18%', tone: 'bg-rose-500' },
    ],
    [
      { left: '4%', width: '20%', tone: 'bg-emerald-500' },
      { left: '34%', width: '32%', tone: 'bg-blue-500' },
      { left: '70%', width: '26%', tone: 'bg-blue-500' },
    ],
    [
      { left: '18%', width: '36%', tone: 'bg-blue-500' },
      { left: '60%', width: '14%', tone: 'bg-amber-500' },
      { left: '80%', width: '16%', tone: 'bg-emerald-500' },
    ],
  ] as const;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex flex-col justify-center gap-6 px-10 opacity-[0.18] blur-[6px]"
    >
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="relative h-8 rounded-md bg-white/[0.04]">
          {row.map((bar, barIndex) => (
            <span
              key={barIndex}
              className={`absolute inset-y-1 rounded ${bar.tone}`}
              style={{ left: bar.left, width: bar.width }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * Staff sign-in, styled as a centred modal over a dimmed backdrop.
 *
 * Two columns above `lg`: the sign-in flow on the left, product showcase on
 * the right. Below `lg` the showcase drops out and the dialog becomes a single
 * column — a clerk on a phone wants the form, not the pitch.
 *
 * Sign-in is two steps (password, then an emailed code) and both render into
 * the left column, so the surrounding chrome never moves between them.
 * `SignInPanel` owns that switch; this page stays a server component.
 */
export default function LoginPage() {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-[#09090b] px-4 py-10 sm:px-6">
      {/* Ambient wash + blurred grid, then a scrim to push both back. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(circle at 50% 0%, rgba(37,99,235,0.16), transparent 55%), radial-gradient(circle at 80% 90%, rgba(129,140,248,0.10), transparent 50%)',
        }}
      />
      <BackdropGrid />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-black/55" />

      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="login-heading"
        className="relative w-full max-w-5xl overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0a0a0b]/95 shadow-[0_32px_120px_-20px_rgba(0,0,0,0.95)] backdrop-blur-2xl"
      >
        {/* Dismiss back to the public site — the modal's close affordance, but
            pointing somewhere real since there is no page underneath. */}
        <a
          href={MARKETING_URL}
          aria-label="Back to easeit.com"
          className="absolute top-4 right-4 z-10 grid size-8 place-items-center rounded-lg text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-zinc-200"
        >
          <X className="size-4" aria-hidden="true" />
        </a>

        <div className="grid lg:grid-cols-[minmax(0,26rem)_1fr]">
          <SignInPanel />
          <ShowcasePanel />
        </div>
      </div>

      <p className="relative mt-6 text-center text-[11px] text-zinc-700">
        © 2026 EaseIt Hospitality Systems
      </p>
    </div>
  );
}
