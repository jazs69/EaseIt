'use client';

/**
 * One guest's fields, with the extended set behind a per-guest toggle.
 *
 * ===========================================================================
 * Its own component because there can be several, and because the PIN-code
 * lookup has to be per guest: two people on one booking routinely have
 * different home addresses, and a shared lookup would overwrite one with the
 * other's city.
 *
 * The lookup is **advisory and non-blocking**. It fills city, state and
 * country when it can, leaves them alone when it cannot, and never prevents
 * typing — the fields stay editable whether or not it answered, because a
 * postal service being slow is not a reason a guest cannot check in.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import {
  GENDER_LABELS,
  GOVT_ID_TYPE_LABELS,
  genderSchema,
  govtIdTypeSchema,
  type ReservationGuestInput,
} from '@repo/types';
import { ChevronDown, Loader2, MapPin, Trash2, User } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { lookupPostalCode } from '@/lib/properties-client';

const inputClass =
  'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none';

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
        {label}
        {required === true ? <span className="ml-0.5 text-rose-400">*</span> : null}
      </span>
      {children}
    </label>
  );
}

export interface GuestCardProps {
  index: number;
  guest: ReservationGuestInput;
  hotelId: string;
  onChange: (patch: Partial<ReservationGuestInput>) => void;
  onRemove: (() => void) | null;
}

export function GuestCard({ index, guest, hotelId, onChange, onRemove }: GuestCardProps) {
  const [showExtra, setShowExtra] = useState(false);
  const [looking, setLooking] = useState(false);
  const [lookupNote, setLookupNote] = useState<string | null>(null);
  const lookupSequence = useRef(0);

  const postalCode = guest.postalCode ?? '';

  /**
   * Resolve the PIN code once it is a complete six digits.
   *
   * No debounce timer beyond the completeness check: a partial code is not a
   * query worth making, and six digits is an unambiguous "done typing".
   * Nothing is written synchronously in this effect — the sequence guard makes
   * a superseded response discard itself rather than overwrite a newer one.
   */
  useEffect(() => {
    if (!/^[1-9][0-9]{5}$/.test(postalCode)) return;

    const controller = new AbortController();
    const sequence = lookupSequence.current + 1;
    lookupSequence.current = sequence;

    void (async () => {
      try {
        const result = await lookupPostalCode(hotelId, postalCode, controller.signal);
        if (lookupSequence.current !== sequence) return;

        setLooking(false);
        setLookupNote(result.note);

        if (result.found) {
          onChange({
            city: result.city,
            state: result.state,
            countryCode: result.countryCode ?? 'IN',
          });
          // Found an address, so show the fields it filled — otherwise the
          // lookup appears to have done nothing.
          setShowExtra(true);
        }
      } catch (caught) {
        if (lookupSequence.current !== sequence) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLooking(false);
        setLookupNote('Address lookup is unavailable. Enter the city and state manually.');
      }
    })();

    return () => {
      controller.abort();
    };
    // `onChange` is recreated per render by the parent; depending on it would
    // re-run the lookup on every keystroke anywhere in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hotelId, postalCode]);

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.015] p-3">
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
          <User className="size-3 text-violet-400" aria-hidden="true" />
          Guest {index + 1}
          {index === 0 ? (
            <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[9px] text-zinc-500">
              Booker
            </span>
          ) : null}
        </span>

        {onRemove !== null ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove guest ${String(index + 1)}`}
            className="grid size-6 place-items-center rounded text-zinc-500 transition-colors hover:bg-white/[0.06] hover:text-rose-300"
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        <Field label="First name" required={index === 0}>
          <input
            value={guest.firstName}
            onChange={(event) => {
              onChange({ firstName: event.target.value });
            }}
            placeholder="Guest name"
            className={inputClass}
          />
        </Field>
        <Field label="Last name">
          <input
            value={guest.lastName}
            onChange={(event) => {
              onChange({ lastName: event.target.value });
            }}
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <Field label="Phone number">
          <input
            value={guest.phone ?? ''}
            onChange={(event) => {
              onChange({ phone: event.target.value });
            }}
            placeholder="+91 98765 43210"
            className={inputClass}
          />
        </Field>
        <Field label="Email address">
          <input
            type="email"
            value={guest.email ?? ''}
            onChange={(event) => {
              onChange({ email: event.target.value });
            }}
            placeholder="name@example.com"
            className={inputClass}
          />
        </Field>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2.5">
        <Field label="PIN code">
          <span className="relative block">
            <input
              value={postalCode}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => {
                const next = event.target.value.replace(/\D/g, '').slice(0, 6);
                onChange({ postalCode: next });
                setLookupNote(null);
                if (/^[1-9][0-9]{5}$/.test(next)) setLooking(true);
              }}
              placeholder="462026"
              className={cn(inputClass, 'tabular pr-7')}
            />
            <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2">
              {looking ? (
                <Loader2 className="size-3 animate-spin text-blue-400" aria-hidden="true" />
              ) : (
                <MapPin className="size-3 text-zinc-600" aria-hidden="true" />
              )}
            </span>
          </span>
        </Field>
        <Field label="ID type">
          <select
            value={guest.govtIdType ?? ''}
            onChange={(event) => {
              onChange({
                govtIdType:
                  event.target.value === ''
                    ? null
                    : (event.target.value as ReservationGuestInput['govtIdType']),
              });
            }}
            className={inputClass}
          >
            <option value="" className="bg-zinc-900">
              Not recorded
            </option>
            {govtIdTypeSchema.options.map((value) => (
              <option key={value} value={value} className="bg-zinc-900">
                {GOVT_ID_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Govt. ID number">
          <input
            value={guest.govtIdNumber ?? ''}
            onChange={(event) => {
              onChange({ govtIdNumber: event.target.value });
            }}
            className={inputClass}
          />
        </Field>
      </div>

      {lookupNote !== null ? (
        <p className="mt-1.5 text-[10px] text-amber-200/70">{lookupNote}</p>
      ) : null}

      <button
        type="button"
        onClick={() => {
          setShowExtra((open) => !open);
        }}
        className="mt-2.5 inline-flex items-center gap-1 text-[10px] font-semibold tracking-wider text-blue-400 uppercase transition-colors hover:text-blue-300"
      >
        <ChevronDown
          className={cn('size-3 transition-transform', showExtra && 'rotate-180')}
          aria-hidden="true"
        />
        {showExtra ? 'Hide additional fields' : 'Show additional fields'}
      </button>

      {showExtra ? (
        <div className="mt-2.5 grid grid-cols-2 gap-2.5 border-t border-white/[0.06] pt-2.5">
          <Field label="Address line 1">
            <input
              value={guest.addressLine1 ?? ''}
              onChange={(event) => {
                onChange({ addressLine1: event.target.value });
              }}
              placeholder="Street, area"
              className={inputClass}
            />
          </Field>
          <Field label="Address line 2">
            <input
              value={guest.addressLine2 ?? ''}
              onChange={(event) => {
                onChange({ addressLine2: event.target.value });
              }}
              className={inputClass}
            />
          </Field>
          <Field label="City">
            <input
              value={guest.city ?? ''}
              onChange={(event) => {
                onChange({ city: event.target.value });
              }}
              className={inputClass}
            />
          </Field>
          <Field label="State">
            <input
              value={guest.state ?? ''}
              onChange={(event) => {
                onChange({ state: event.target.value });
              }}
              className={inputClass}
            />
          </Field>
          <Field label="Country">
            <input
              value={guest.countryCode ?? ''}
              maxLength={2}
              onChange={(event) => {
                onChange({ countryCode: event.target.value.toUpperCase().slice(0, 2) });
              }}
              placeholder="IN"
              className={cn(inputClass, 'uppercase')}
            />
          </Field>
          <Field label="Gender">
            <select
              value={guest.gender ?? ''}
              onChange={(event) => {
                onChange({
                  gender:
                    event.target.value === ''
                      ? null
                      : (event.target.value as ReservationGuestInput['gender']),
                });
              }}
              className={inputClass}
            >
              <option value="" className="bg-zinc-900">
                Not recorded
              </option>
              {genderSchema.options.map((value) => (
                <option key={value} value={value} className="bg-zinc-900">
                  {GENDER_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date of birth">
            <input
              type="date"
              value={guest.dateOfBirth ?? ''}
              onChange={(event) => {
                onChange({
                  dateOfBirth:
                    event.target.value === ''
                      ? null
                      : (event.target.value as ReservationGuestInput['dateOfBirth']),
                });
              }}
              className={cn(inputClass, 'tabular')}
            />
          </Field>
          <Field label="Nationality">
            <input
              value={guest.nationality ?? ''}
              onChange={(event) => {
                onChange({ nationality: event.target.value });
              }}
              placeholder="Indian"
              className={inputClass}
            />
          </Field>
          <Field label="Occupation">
            <input
              value={guest.occupation ?? ''}
              onChange={(event) => {
                onChange({ occupation: event.target.value });
              }}
              className={inputClass}
            />
          </Field>
          <Field label="Special request">
            <input
              value={guest.specialRequest ?? ''}
              onChange={(event) => {
                onChange({ specialRequest: event.target.value });
              }}
              placeholder="Late arrival, high floor…"
              className={inputClass}
            />
          </Field>
        </div>
      ) : null}
    </div>
  );
}

/** A blank guest, so every card starts from the same shape. */
export function emptyGuest(): ReservationGuestInput {
  return {
    firstName: '',
    lastName: '',
    email: null,
    phone: null,
    addressLine1: null,
    addressLine2: null,
    city: null,
    state: null,
    postalCode: null,
    // India by default, matching the portfolio. Still editable.
    countryCode: 'IN',
    gender: null,
    dateOfBirth: null,
    nationality: null,
    occupation: null,
    govtIdType: null,
    govtIdNumber: null,
    specialRequest: null,
  };
}
