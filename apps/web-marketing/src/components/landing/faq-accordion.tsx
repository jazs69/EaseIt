'use client';

import { cn } from '@repo/ui';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';

import { GradientText } from './primitives';

export interface FaqItem {
  question: string;
  answer: string;
}

const ITEMS: readonly FaqItem[] = [
  {
    question: 'Can I run all ten properties from one login?',
    answer:
      'Yes. One account holds a grant per property, so the same person can be front desk at one hotel and property admin at another. Switching property re-authorises on the server and returns a fresh permission set — the browser never decides what you can see.',
  },
  {
    question: 'How fast does the channel manager actually sync?',
    answer:
      'Rate and inventory pushes are debounced per room type and date range, then sent in order, typically landing on each OTA within a second. Inbound reservations are stored raw first and normalised second, so a parser change can never lose a booking. Every attempt is logged with its request and response for dispute resolution.',
  },
  {
    question: 'What does migrating off a legacy PMS involve?',
    answer:
      'We import your room types, rate plans, future reservations and guest profiles, then run both systems in parallel for one billing cycle while the night audit totals are reconciled against your existing reports. Cutover happens after a business date closes, never mid-day.',
  },
  {
    question: 'Which payment providers are supported?',
    answer:
      'Razorpay, Stripe and PayU for cards and UPI, with card-on-file tokenisation for the guest portal. Amounts are stored as integers in the currency minor unit, so a folio balance is always the exact sum of its lines rather than a float that drifts by a paisa per posting.',
  },
  {
    question: 'How is one property kept from reading another one?',
    answer:
      'Every operational row carries a propertyId, and every query is filtered by the active property through an ORM extension rather than by hand at each call site. PostgreSQL row-level security sits underneath as a backstop for the day someone forgets. Cross-property reads require an explicit, audited escape hatch.',
  },
];

interface AccordionRowProps {
  item: FaqItem;
  isOpen: boolean;
  onToggle: () => void;
  index: number;
}

function AccordionRow({ item, isOpen, onToggle, index }: AccordionRowProps) {
  const panelId = `faq-panel-${String(index)}`;
  const buttonId = `faq-button-${String(index)}`;

  return (
    <div className="border-b border-white/[0.08]">
      <h3>
        <button
          type="button"
          id={buttonId}
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-controls={panelId}
          className="flex w-full items-center justify-between gap-4 py-5 text-left transition-colors hover:text-white"
        >
          <span
            className={cn(
              'text-[15px] font-medium transition-colors',
              isOpen ? 'text-white' : 'text-zinc-300',
            )}
          >
            {item.question}
          </span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 text-zinc-500 transition-transform duration-300',
              isOpen && 'rotate-180 text-blue-400',
            )}
            aria-hidden="true"
          />
        </button>
      </h3>

      {/* Grid-rows transition animates to the content's natural height without
          hardcoding a max-height that would clip a long answer. */}
      <div
        id={panelId}
        role="region"
        aria-labelledby={buttonId}
        className={cn(
          'grid transition-all duration-300 ease-out',
          isOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <div className="overflow-hidden">
          <p className="pb-5 text-sm leading-relaxed text-zinc-400">{item.answer}</p>
        </div>
      </div>
    </div>
  );
}

export function FaqAccordion() {
  const [openIndex, setOpenIndex] = useState<number | null>(0);

  return (
    <section id="docs" className="relative px-4 py-20 sm:px-6 lg:px-8">
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
        <div className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
          <span className="text-xs font-semibold tracking-[0.2em] text-blue-400 uppercase">
            FAQ
          </span>
          <h2 className="text-3xl font-semibold tracking-tight text-balance text-white sm:text-4xl">
            Questions, <GradientText>answered</GradientText>
          </h2>
          <p className="max-w-sm text-sm leading-relaxed text-zinc-400">
            Still unsure about something? Talk to the team that runs the migrations — not a
            reseller.
          </p>
          <a
            href="#get-started"
            className="mt-2 inline-flex w-fit items-center gap-1.5 text-sm font-medium text-blue-400 transition-colors hover:text-blue-300"
          >
            Book a technical call
            <ChevronDown className="size-3.5 -rotate-90" aria-hidden="true" />
          </a>
        </div>

        <div className="border-t border-white/[0.08]">
          {ITEMS.map((item, index) => (
            <AccordionRow
              key={item.question}
              item={item}
              index={index}
              isOpen={openIndex === index}
              onToggle={() => setOpenIndex(openIndex === index ? null : index)}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
