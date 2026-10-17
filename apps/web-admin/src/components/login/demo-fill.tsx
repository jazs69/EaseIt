'use client';

import { cn } from '@repo/ui';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

/**
 * Development-only credential filler.
 *
 * ===========================================================================
 * Note the shape of the guard below. The check is an **inline literal
 * comparison** against `process.env.NODE_ENV`, and the credential data is
 * declared *after* it, inside the function body.
 *
 * That is deliberate and load-bearing. Bundlers replace
 * `process.env.NODE_ENV` with the string `"production"`, so the guard
 * minifies to `if (true) return null;` and everything below it becomes
 * provably unreachable and is dropped.
 *
 * An earlier version used an exported `IS_DEV` const from another module and
 * a module-level credential array. That reads identically but defeats
 * dead-code elimination entirely: the addresses and the seed password shipped
 * in the production client chunk and in the prerendered login.html.
 *
 * So: do not hoist `CREDENTIALS` to module scope, and do not replace the
 * guard with an imported boolean.
 * ===========================================================================
 */

interface DemoFillProps {
  onFill: (email: string, password: string) => void;
  disabled: boolean;
}

interface DemoCredential {
  label: string;
  email: string;
  password: string;
}

export function DemoFill({ onFill, disabled }: DemoFillProps) {
  const [open, setOpen] = useState(false);

  if (process.env.NODE_ENV === 'production') return null;

  // Seeded accounts for Grand Marine Goa — see
  // packages/database/prisma/seed.ts. Declared here, after the guard, so they
  // are unreachable in a production build.
  const CREDENTIALS: readonly DemoCredential[] = [
    {
      label: 'Fill Admin',
      email: 'property.admin@grand-marine-goa.example.com',
      password: 'EaseIt-Dev-2026!',
    },
    {
      label: 'Fill Front Desk',
      email: 'front.desk@grand-marine-goa.example.com',
      password: 'EaseIt-Dev-2026!',
    },
    {
      label: 'Fill Night Auditor',
      email: 'night.auditor@grand-marine-goa.example.com',
      password: 'EaseIt-Dev-2026!',
    },
  ];

  return (
    <div className="rounded-xl border border-white/[0.08] bg-white/[0.02]">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left"
      >
        <span className="rounded-full border border-amber-400/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wider text-amber-300 uppercase">
          Dev
        </span>
        <span className="text-xs text-zinc-400">Quick role fill</span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 text-zinc-500 transition-transform duration-200',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {open ? (
        <div className="flex flex-wrap gap-2 border-t border-white/[0.06] p-3">
          {CREDENTIALS.map((credential) => (
            <button
              key={credential.label}
              type="button"
              disabled={disabled}
              onClick={() => {
                onFill(credential.email, credential.password);
              }}
              className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 py-1.5 text-[11px] font-medium text-zinc-300 transition-colors hover:border-blue-500/30 hover:text-white disabled:opacity-50"
            >
              {credential.label}
            </button>
          ))}
          <p className="w-full pt-1 text-[10px] leading-relaxed text-zinc-600">
            Seeded accounts from <code>packages/database/prisma/seed.ts</code>. Run{' '}
            <code>pnpm db:seed</code> first.
          </p>
        </div>
      ) : null}
    </div>
  );
}
