'use client';

/**
 * Corporate billing: pick a saved company, or add one by GSTIN.
 *
 * ===========================================================================
 * The GSTIN check is **arithmetic, not verification**, and the UI says so.
 *
 * A GSTIN carries its own mod-36 check digit, so a typo is detectable offline
 * with certainty — that is what the green state means here, and it catches
 * every single-character error and transposition.
 *
 * What it does not mean is that the business is registered. Confirming that
 * needs credentialled GST Network access this deployment does not have, so the
 * operator types the legal name. The brief asked for a "verified Legal Name"
 * badge; inventing one would be the worst possible outcome of this feature,
 * because the legal name is the thing a tax invoice is *for* — a plausible
 * fabrication gets filed, claimed against, and found by an auditor rather than
 * by us.
 * ===========================================================================
 */

import { cn } from '@repo/ui';
import type { CompanySummary, GstinLookup } from '@repo/types';
import {
  Building2,
  Check,
  FlaskConical,
  Loader2,
  Plus,
  ShieldCheck,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { createCompany, lookupGstin } from '@/lib/properties-client';

const inputClass =
  'w-full rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-xs text-white placeholder:text-zinc-600 focus:border-blue-500 focus:outline-none';

export interface CompanySectionProps {
  hotelId: string;
  companies: readonly CompanySummary[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onCompanyAdded: (company: CompanySummary) => void;
}

export function CompanySection({
  hotelId,
  companies,
  selectedId,
  onSelect,
  onCompanyAdded,
}: CompanySectionProps) {
  const [adding, setAdding] = useState(false);
  const [gstin, setGstin] = useState('');
  const [lookup, setLookup] = useState<GstinLookup | null>(null);
  const [legalName, setLegalName] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);

  /** Check the number once it is the full fifteen characters. */
  useEffect(() => {
    if (gstin.length !== 15) return;

    const controller = new AbortController();
    const current = sequence.current + 1;
    sequence.current = current;

    void (async () => {
      try {
        const result = await lookupGstin(hotelId, gstin, controller.signal);
        if (sequence.current !== current) return;
        setLookup(result);
        // Prefilled, not locked: the operator can always correct it, which
        // matters most when the provider is mock and the name is invented.
        if (result.companyName !== null) setLegalName(result.companyName);
        if (result.address?.fullAddress != null) setAddress(result.address.fullAddress);
      } catch (caught) {
        if (sequence.current !== current) return;
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        setLookup(null);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [hotelId, gstin]);

  const selected = companies.find((company) => company.id === selectedId) ?? null;

  async function save(): Promise<void> {
    if (lookup === null || !lookup.isValid || legalName.trim().length === 0) return;
    setSaving(true);
    setError(null);

    try {
      const company = await createCompany(hotelId, {
        gstin: lookup.gstin,
        legalName: legalName.trim(),
        tradeName: null,
        addressLine1: address.trim() === '' ? null : address.trim(),
        city: null,
        // Read off the GSTIN's own state digits rather than asked for again.
        state: lookup.stateName,
        postalCode: null,
        email: null,
        phone: null,
        // What the client believes. The server re-runs the lookup and stores
        // its own answer, so this cannot launder a typed name into a
        // verified one.
        verification: lookup.verification,
      });

      onCompanyAdded(company);
      onSelect(company.id);
      setAdding(false);
      setGstin('');
      setLookup(null);
      setLegalName('');
      setAddress('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The company could not be saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-2xl border border-white/[0.08] bg-[#0f141f]/70 p-4">
      <h3 className="mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase">
        <span className="grid size-6 place-items-center rounded-lg bg-sky-500/15 text-sky-400">
          <Building2 className="size-3.5" aria-hidden="true" />
        </span>
        Company (optional)
      </h3>

      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
            Bill to
          </span>
          <select
            value={selectedId ?? ''}
            onChange={(event) => {
              onSelect(event.target.value === '' ? null : event.target.value);
            }}
            className={inputClass}
          >
            <option value="" className="bg-zinc-900">
              No company — guest pays
            </option>
            {companies.map((company) => (
              <option key={company.id} value={company.id} className="bg-zinc-900">
                {company.legalName} · {company.gstin}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={() => {
            setAdding((open) => !open);
            setError(null);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-white/10 bg-zinc-900/60 px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 transition-colors hover:border-white/25"
        >
          {adding ? (
            <X className="size-3" aria-hidden="true" />
          ) : (
            <Plus className="size-3" aria-hidden="true" />
          )}
          {adding ? 'Cancel' : 'Add new'}
        </button>
      </div>

      {selected !== null && !adding ? (
        <p className="mt-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] leading-relaxed text-zinc-400">
          <span className="font-semibold text-zinc-200">{selected.legalName}</span>
          <br />
          <span className="tabular">{selected.gstin}</span>
          {selected.state === null ? null : ` · ${selected.state}`}
          <br />
          <span className="text-zinc-600">
            This name, GSTIN and address appear on the tax invoice.
          </span>
        </p>
      ) : null}

      {adding ? (
        <div className="mt-3 flex flex-col gap-2.5 border-t border-white/[0.06] pt-3">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
              GSTIN
            </span>
            <input
              value={gstin}
              maxLength={15}
              onChange={(event) => {
                setGstin(event.target.value.toUpperCase().replace(/\s/g, '').slice(0, 15));
                setLookup(null);
              }}
              placeholder="27AAPFU0939F1ZV"
              className={cn(inputClass, 'tabular uppercase')}
            />
          </label>

          {gstin.length === 15 && lookup === null ? (
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
              <Loader2 className="size-3 animate-spin" aria-hidden="true" />
              Checking…
            </p>
          ) : null}

          {lookup !== null && !lookup.isValid ? (
            <p className="flex items-start gap-1.5 rounded-lg border border-rose-400/25 bg-rose-500/[0.08] px-2.5 py-1.5 text-[11px] text-rose-200">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              {lookup.reason}
            </p>
          ) : null}

          {lookup !== null && lookup.isValid ? (
            <>
              {/* Three visually distinct states, because they are three
                  different assurances. Green only when a live registry
                  confirmed the taxpayer; amber for synthetic development data;
                  neutral when only the check digit was checked. Collapsing
                  them into one green tick is how a fabricated name reaches a
                  tax invoice. */}
              {lookup.verification === 'VERIFIED' ? (
                <p className="flex items-start gap-1.5 rounded-lg border border-emerald-400/25 bg-emerald-500/[0.08] px-2.5 py-1.5 text-[11px] text-emerald-200">
                  <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="font-semibold">Verified taxpayer</span>
                    {lookup.status === null ? null : ` · ${lookup.status}`} ·{' '}
                    {lookup.stateName}
                    <br />
                    <span className="text-emerald-200/60">
                      Confirmed against the GST registry via {lookup.provider}.
                    </span>
                  </span>
                </p>
              ) : lookup.verification === 'MOCK' ? (
                <p className="flex items-start gap-1.5 rounded-lg border border-amber-400/30 bg-amber-500/[0.1] px-2.5 py-1.5 text-[11px] text-amber-200">
                  <FlaskConical className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                  <span>
                    <span className="font-semibold">Mock data — not verified</span> ·{' '}
                    {lookup.stateName}
                    <br />
                    <span className="text-amber-200/70">
                      The lookup provider is set to mock, so this name is invented. It is
                      saved tagged as MOCK and must not be used on a real invoice.
                    </span>
                  </span>
                </p>
              ) : (
                <p className="flex items-start gap-1.5 rounded-lg border border-white/[0.12] bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-zinc-300">
                  <Check className="mt-0.5 size-3 shrink-0 text-zinc-400" aria-hidden="true" />
                  <span>
                    Valid GSTIN · {lookup.stateName} · PAN {lookup.pan}
                    <br />
                    <span className="text-zinc-500">
                      {lookup.reason ??
                        'The number checks out arithmetically but was not verified against the registry. Enter the legal name exactly as registered.'}
                    </span>
                  </span>
                </p>
              )}

              {lookup.address?.fullAddress == null ? null : (
                <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-1.5 text-[11px] leading-relaxed text-zinc-400">
                  <span className="text-[10px] tracking-wider text-zinc-600 uppercase">
                    Registered address
                  </span>
                  <br />
                  {lookup.address.fullAddress}
                </p>
              )}

              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                  Registered legal name <span className="text-rose-400">*</span>
                </span>
                <input
                  value={legalName}
                  onChange={(event) => {
                    setLegalName(event.target.value);
                  }}
                  placeholder="As printed on the GST certificate"
                  className={inputClass}
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] font-medium tracking-wide text-zinc-500 uppercase">
                  Principal place of business
                </span>
                <input
                  value={address}
                  onChange={(event) => {
                    setAddress(event.target.value);
                  }}
                  className={inputClass}
                />
              </label>

              {error !== null ? (
                <p className="text-[11px] text-rose-300">{error}</p>
              ) : null}

              <button
                type="button"
                onClick={() => {
                  void save();
                }}
                disabled={saving || legalName.trim().length === 0}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-white px-3 py-1.5 text-[11px] font-semibold text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? <Loader2 className="size-3 animate-spin" aria-hidden="true" /> : null}
                Save &amp; add company
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
