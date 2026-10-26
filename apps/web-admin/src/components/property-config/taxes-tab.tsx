'use client';

/**
 * Taxes & surcharges.
 *
 * ===========================================================================
 * This tab decides what guests are charged, so it checks the table before it
 * offers to save it.
 *
 * A GST slab table is only valid as a *set*: a floor at zero, no gaps, no
 * overlaps, and exactly one open-ended top band. A single row that looks fine
 * can still break the table, so the whole table is validated on every
 * keystroke and Save stays disabled until it holds together — and the server
 * validates it again and swaps it inside one transaction, so a rejection
 * leaves the live table untouched rather than half-replaced.
 *
 * The same checks exist in three places on purpose: here so an operator sees
 * which row is wrong, in the service so an API caller cannot bypass the form,
 * and as CHECK constraints so nothing at all can write a contradictory row.
 * The constraints are the guarantee; these two are the explanation.
 *
 * Bounds are shown in major units and held as integer minor units. A rate is a
 * rate and may carry decimals; an amount never becomes a float (section 3.4).
 * ===========================================================================
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { FeeAndSurcharge, PropertySetup, TaxSlab } from '@repo/types';

import { formatMoney } from '@/lib/money';
import {
  Field,
  NotWiredNotice,
  SaveBar,
  Section,
  Select,
  TextInput,
  Toggle,
} from './fields';
import type { PropertySettingsState } from './use-property-settings';

/** A slab being edited: every number is a string while it is being typed. */
interface SlabDraft {
  key: string;
  slabName: string;
  minMajor: string;
  maxMajor: string;
  cgst: string;
  sgst: string;
}

const FEE_TYPES = [
  { value: 'PERCENTAGE', label: 'Percentage of the tariff' },
  { value: 'FIXED_PER_NIGHT', label: 'Fixed, per night' },
  { value: 'FIXED_PER_STAY', label: 'Fixed, per stay' },
  { value: 'FIXED_PER_GUEST', label: 'Fixed, per guest' },
] as const;

export function TaxesTab({ state }: { state: PropertySettingsState }) {
  const { setup, saving, savedTab, saveTaxSlabs, saveFees } = state;

  const [draft, setDraft] = useState<{ from: PropertySetup; value: SlabDraft[] } | null>(
    null,
  );
  const slabs = draft !== null && draft.from === setup ? draft.value : toDrafts(setup.taxSlabs);
  const [reason, setReason] = useState('');

  const parsed = slabs.map(parseSlab);
  const rowErrors = parsed.map((row) => row.error);
  const tableProblems = tableErrorsFor(parsed);
  const valid = rowErrors.every((error) => error === null) && tableProblems.length === 0;
  const dirty = JSON.stringify(slabs) !== JSON.stringify(toDrafts(setup.taxSlabs));

  const setSlabs = (next: SlabDraft[]) => {
    setDraft({ from: setup, value: next });
  };
  const patch = (index: number, change: Partial<SlabDraft>) => {
    setSlabs(slabs.map((slab, i) => (i === index ? { ...slab, ...change } : slab)));
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="GST slabs on room tariff"
        description="The rate depends on what the room costs per night. The band is decided by the nightly tariff, never by the stay total — four nights at ₹3,000 is a ₹3,000 room, not a ₹12,000 one."
        action={
          <SaveBar
            dirty={dirty && valid}
            saving={saving}
            saved={savedTab === 'taxes'}
            onSave={() => {
              const table = parsed
                .map((row) => row.slab)
                .filter((slab): slab is TaxSlab => slab !== null);
              void saveTaxSlabs(table, reason.trim() === '' ? null : reason.trim());
            }}
            onReset={() => {
              setDraft(null);
              setReason('');
            }}
          />
        }
      >
        {tableProblems.length > 0 ? (
          <ul className="mb-4 space-y-1 rounded-lg border border-rose-500/25 bg-rose-500/[0.06] px-3 py-2">
            {tableProblems.map((problem) => (
              <li key={problem} className="text-xs leading-relaxed text-rose-200/90">
                {problem}
              </li>
            ))}
          </ul>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-white/[0.08] text-left">
                <Th>Band</Th>
                <Th className="w-28">From (₹/night)</Th>
                <Th className="w-28">To (₹/night)</Th>
                <Th className="w-24">CGST %</Th>
                <Th className="w-24">SGST %</Th>
                <Th className="w-20">Total</Th>
                <Th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {slabs.map((slab, index) => {
                const row = parsed[index];
                const total =
                  row?.slab === null || row?.slab === undefined
                    ? null
                    : row.slab.taxRatePercent;
                return (
                  <tr key={slab.key} className="border-b border-white/[0.04] align-top">
                    <Td>
                      <TextInput
                        value={slab.slabName}
                        disabled={saving}
                        placeholder="Standard tariff"
                        onChange={(slabName) => {
                          patch(index, { slabName });
                        }}
                      />
                    </Td>
                    <Td>
                      <TextInput
                        value={slab.minMajor}
                        disabled={saving}
                        inputMode="decimal"
                        onChange={(minMajor) => {
                          patch(index, { minMajor });
                        }}
                      />
                    </Td>
                    <Td>
                      <TextInput
                        value={slab.maxMajor}
                        disabled={saving}
                        inputMode="decimal"
                        placeholder="no limit"
                        onChange={(maxMajor) => {
                          patch(index, { maxMajor });
                        }}
                      />
                    </Td>
                    <Td>
                      <TextInput
                        value={slab.cgst}
                        disabled={saving}
                        inputMode="decimal"
                        onChange={(cgst) => {
                          patch(index, { cgst });
                        }}
                      />
                    </Td>
                    <Td>
                      <TextInput
                        value={slab.sgst}
                        disabled={saving}
                        inputMode="decimal"
                        onChange={(sgst) => {
                          patch(index, { sgst });
                        }}
                      />
                    </Td>
                    <Td>
                      <span className="block px-1 py-2 text-sm font-semibold text-white tabular-nums">
                        {total === null ? '—' : `${String(total)}%`}
                      </span>
                    </Td>
                    <Td>
                      <button
                        type="button"
                        disabled={saving || slabs.length === 1}
                        title={
                          slabs.length === 1
                            ? 'A property needs at least one band'
                            : 'Remove this band'
                        }
                        onClick={() => {
                          setSlabs(slabs.filter((_, i) => i !== index));
                        }}
                        className="rounded-md p-2 text-zinc-500 transition-colors hover:bg-rose-500/10 hover:text-rose-400 disabled:cursor-not-allowed disabled:opacity-30"
                      >
                        <Trash2 className="size-3.5" aria-hidden="true" />
                        <span className="sr-only">Remove band</span>
                      </button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {rowErrors.some((error) => error !== null) ? (
          <ul className="mt-3 space-y-1">
            {rowErrors.map((error, index) =>
              error === null ? null : (
                <li key={slabs[index]?.key ?? index} className="text-xs text-rose-400">
                  Row {String(index + 1)}: {error}
                </li>
              ),
            )}
          </ul>
        ) : null}

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setSlabs([
                ...slabs,
                {
                  key: `new-${String(Date.now())}`,
                  slabName: '',
                  minMajor: '',
                  maxMajor: '',
                  cgst: '',
                  sgst: '',
                },
              ]);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add a band
          </button>
          <div className="min-w-[16rem] flex-1">
            <Field
              label="Reason for the change"
              hint="Recorded in the audit trail beside the old and new tables."
            >
              <TextInput
                value={reason}
                disabled={saving}
                placeholder="e.g. GST Council notification 03/2026"
                onChange={setReason}
              />
            </Field>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-zinc-500">
          CGST and SGST are stored separately rather than halved at print time: that split
          is right for an intra-state supply and wrong for an inter-state one, which is
          IGST and is not split at all. Leave SGST at zero to configure an IGST band.
        </p>
      </Section>

      <FeesSection
        setup={setup}
        saving={saving}
        onSave={(fees, feeReason) => {
          void saveFees(fees, feeReason);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Fees                                                                      */
/* -------------------------------------------------------------------------- */

interface FeeDraft {
  key: string;
  name: string;
  type: FeeAndSurcharge['type'];
  amountMajor: string;
  ratePercent: string;
  isTaxable: boolean;
  applyToGroup: boolean;
}

function FeesSection({
  setup,
  saving,
  onSave,
}: {
  setup: PropertySetup;
  saving: boolean;
  onSave: (
    fees: {
      name: string;
      type: FeeAndSurcharge['type'];
      amountMinor: number;
      ratePercent: number | null;
      isTaxable: boolean;
      applyToGroup: boolean;
    }[],
    reason: string | null,
  ) => void;
}) {
  const [draft, setDraft] = useState<{ from: PropertySetup; value: FeeDraft[] } | null>(
    null,
  );
  const fees = draft !== null && draft.from === setup ? draft.value : toFeeDrafts(setup.fees);
  const dirty = JSON.stringify(fees) !== JSON.stringify(toFeeDrafts(setup.fees));

  const parsed = fees.map(parseFee);
  const valid = parsed.every((row) => row.error === null);

  const setFees = (next: FeeDraft[]) => {
    setDraft({ from: setup, value: next });
  };
  const patch = (index: number, change: Partial<FeeDraft>) => {
    setFees(fees.map((fee, i) => (i === index ? { ...fee, ...change } : fee)));
  };

  return (
    <Section
      title="Fees and surcharges"
      description="What the property charges beyond the room tariff."
      action={
        <SaveBar
          dirty={dirty && valid}
          saving={saving}
          saved={false}
          onSave={() => {
            onSave(
              parsed
                .map((row) => row.fee)
                .filter((fee): fee is NonNullable<typeof fee> => fee !== null),
              null,
            );
          }}
          onReset={() => {
            setDraft(null);
          }}
        />
      }
    >
      <NotWiredNotice>
        Recorded, not yet billed. No charge path reads these — the folio posts room
        charges, their tax and whatever a clerk enters by hand. Setting them now means
        the module that posts them finds the policy already configured; it does not make
        them appear on a bill today.
      </NotWiredNotice>

      {fees.length === 0 ? (
        <p className="mt-4 text-xs text-zinc-500">No fees configured.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-3">
          {fees.map((fee, index) => {
            const row = parsed[index];
            return (
              <div
                key={fee.key}
                className="grid gap-3 rounded-lg border border-white/[0.06] p-3 sm:grid-cols-2 lg:grid-cols-4"
              >
                <Field label="Name">
                  <TextInput
                    value={fee.name}
                    disabled={saving}
                    onChange={(name) => {
                      patch(index, { name });
                    }}
                  />
                </Field>
                <Field label="How it is charged">
                  <Select
                    value={fee.type}
                    options={FEE_TYPES}
                    disabled={saving}
                    onChange={(type) => {
                      // Switching kind clears the field that no longer
                      // applies, so the two can never both carry a value —
                      // which is what the CHECK constraint forbids.
                      patch(index, {
                        type,
                        ...(type === 'PERCENTAGE'
                          ? { amountMajor: '0' }
                          : { ratePercent: '' }),
                      });
                    }}
                  />
                </Field>
                {fee.type === 'PERCENTAGE' ? (
                  <Field label="Rate %" error={row?.error ?? undefined}>
                    <TextInput
                      value={fee.ratePercent}
                      disabled={saving}
                      inputMode="decimal"
                      onChange={(ratePercent) => {
                        patch(index, { ratePercent });
                      }}
                    />
                  </Field>
                ) : (
                  <Field
                    label={`Amount (${setup.currency})`}
                    error={row?.error ?? undefined}
                  >
                    <TextInput
                      value={fee.amountMajor}
                      disabled={saving}
                      inputMode="decimal"
                      onChange={(amountMajor) => {
                        patch(index, { amountMajor });
                      }}
                    />
                  </Field>
                )}
                <div className="flex flex-col justify-center gap-2">
                  <Toggle
                    checked={fee.isTaxable}
                    disabled={saving}
                    label="Taxable"
                    onChange={(isTaxable) => {
                      patch(index, { isTaxable });
                    }}
                  />
                  <Toggle
                    checked={fee.applyToGroup}
                    disabled={saving}
                    label="Applies per group booking"
                    onChange={(applyToGroup) => {
                      patch(index, { applyToGroup });
                    }}
                  />
                </div>
                <div className="lg:col-span-4">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setFees(fees.filter((_, i) => i !== index));
                    }}
                    className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-rose-400"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                    Remove
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <button
        type="button"
        disabled={saving}
        onClick={() => {
          setFees([
            ...fees,
            {
              key: `new-${String(Date.now())}`,
              name: '',
              type: 'FIXED_PER_STAY',
              amountMajor: '0',
              ratePercent: '',
              isTaxable: true,
              applyToGroup: false,
            },
          ]);
        }}
        className="mt-4 flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        Add a fee
      </button>
    </Section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Parsing and validation                                                    */
/* -------------------------------------------------------------------------- */

function toDrafts(slabs: readonly TaxSlab[]): SlabDraft[] {
  const drafts = slabs.map((slab, index) => ({
    key: slab.id ?? `slab-${String(index)}`,
    slabName: slab.slabName,
    minMajor: majorOf(slab.minTariffMinor),
    maxMajor: slab.maxTariffMinor === null ? '' : majorOf(slab.maxTariffMinor),
    cgst: String(slab.cgstRatePercent),
    sgst: String(slab.sgstRatePercent),
  }));

  // A property with no table yet still needs a row to type into.
  return drafts.length > 0
    ? drafts
    : [{ key: 'slab-0', slabName: '', minMajor: '0', maxMajor: '', cgst: '', sgst: '' }];
}

/** Minor units to a major-unit string, without introducing a float total. */
function majorOf(minor: number): string {
  return (minor / 100).toFixed(2).replace(/\.00$/, '');
}

/** A major-unit string to integer minor units, or null if it is not a number. */
function minorOf(major: string): number | null {
  const trimmed = major.trim();
  if (trimmed === '' || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  return Math.round(Number(trimmed) * 100);
}

function parseSlab(draft: SlabDraft): { slab: TaxSlab | null; error: string | null } {
  if (draft.slabName.trim() === '') {
    return { slab: null, error: 'Give the band a name.' };
  }

  const minTariffMinor = minorOf(draft.minMajor);
  if (minTariffMinor === null) {
    return { slab: null, error: 'The floor must be an amount, to at most two decimals.' };
  }

  const maxTariffMinor = draft.maxMajor.trim() === '' ? null : minorOf(draft.maxMajor);
  if (draft.maxMajor.trim() !== '' && maxTariffMinor === null) {
    return {
      slab: null,
      error: 'The ceiling must be an amount, or empty for an open-ended band.',
    };
  }
  if (maxTariffMinor !== null && maxTariffMinor <= minTariffMinor) {
    return { slab: null, error: 'The ceiling must be above the floor.' };
  }

  const cgst = ratePercentOf(draft.cgst);
  const sgst = ratePercentOf(draft.sgst);
  if (cgst === null || sgst === null) {
    return { slab: null, error: 'CGST and SGST must be percentages between 0 and 100.' };
  }

  // Summed in hundredths to avoid 6 + 6 !== 12 from binary floating point.
  const taxRatePercent = Math.round((cgst + sgst) * 100) / 100;
  if (taxRatePercent > 100) {
    return { slab: null, error: 'The components add up to more than 100%.' };
  }

  return {
    slab: {
      slabName: draft.slabName.trim(),
      minTariffMinor,
      maxTariffMinor,
      taxRatePercent,
      cgstRatePercent: cgst,
      sgstRatePercent: sgst,
    },
    error: null,
  };
}

function ratePercentOf(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '' || !/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= 0 && value <= 100 ? value : null;
}

/**
 * The problems only visible across rows.
 *
 * Mirrors `validateSlabTable` in the API's tax engine. Duplicated rather than
 * shared because the engine lives in `apps/api` and the browser must not
 * import from it; if a third consumer appears it moves to `packages/types`
 * beside the schema it validates.
 */
function tableErrorsFor(
  rows: readonly { slab: TaxSlab | null; error: string | null }[],
): string[] {
  const slabs = rows
    .map((row) => row.slab)
    .filter((slab): slab is TaxSlab => slab !== null);
  if (slabs.length !== rows.length) return [];

  const problems: string[] = [];
  const ordered = [...slabs].sort((a, b) => a.minTariffMinor - b.minTariffMinor);

  const first = ordered[0];
  if (first !== undefined && first.minTariffMinor !== 0) {
    problems.push(
      'The lowest band must start at 0, or a tariff below it would be taxed at no rate.',
    );
  }

  const openEnded = ordered.filter((slab) => slab.maxTariffMinor === null);
  if (openEnded.length === 0) {
    problems.push(
      'One band must be open-ended, or a tariff above the highest ceiling would be taxed at no rate.',
    );
  } else if (openEnded.length > 1) {
    problems.push('Only one band may be open-ended.');
  }

  for (let index = 0; index < ordered.length - 1; index += 1) {
    const slab = ordered[index];
    const next = ordered[index + 1];
    if (slab === undefined || next === undefined) continue;

    if (slab.maxTariffMinor === null) {
      problems.push(
        `“${slab.slabName}” is open-ended but is not the highest band, so it swallows “${next.slabName}”.`,
      );
      continue;
    }
    if (slab.maxTariffMinor > next.minTariffMinor) {
      problems.push(`“${slab.slabName}” overlaps “${next.slabName}”.`);
    }
    if (slab.maxTariffMinor < next.minTariffMinor) {
      problems.push(
        `A gap sits between “${slab.slabName}” and “${next.slabName}”: ${formatMoney(
          slab.maxTariffMinor,
          'INR',
        )} to ${formatMoney(next.minTariffMinor, 'INR')} falls in no band.`,
      );
    }
  }

  return problems;
}

function toFeeDrafts(fees: readonly FeeAndSurcharge[]): FeeDraft[] {
  return fees.map((fee) => ({
    key: fee.id,
    name: fee.name,
    type: fee.type,
    amountMajor: majorOf(fee.amountMinor),
    ratePercent: fee.ratePercent === null ? '' : String(fee.ratePercent),
    isTaxable: fee.isTaxable,
    applyToGroup: fee.applyToGroup,
  }));
}

function parseFee(draft: FeeDraft): {
  fee: {
    name: string;
    type: FeeAndSurcharge['type'];
    amountMinor: number;
    ratePercent: number | null;
    isTaxable: boolean;
    applyToGroup: boolean;
  } | null;
  error: string | null;
} {
  if (draft.name.trim() === '') return { fee: null, error: 'Give the fee a name.' };

  if (draft.type === 'PERCENTAGE') {
    const rate = ratePercentOf(draft.ratePercent);
    if (rate === null || rate === 0) {
      return { fee: null, error: 'A percentage fee needs a rate above zero.' };
    }
    return {
      fee: {
        name: draft.name.trim(),
        type: draft.type,
        amountMinor: 0,
        ratePercent: rate,
        isTaxable: draft.isTaxable,
        applyToGroup: draft.applyToGroup,
      },
      error: null,
    };
  }

  const amountMinor = minorOf(draft.amountMajor);
  if (amountMinor === null) {
    return { fee: null, error: 'The amount must be a figure, to at most two decimals.' };
  }
  return {
    fee: {
      name: draft.name.trim(),
      type: draft.type,
      amountMinor,
      ratePercent: null,
      isTaxable: draft.isTaxable,
      applyToGroup: draft.applyToGroup,
    },
    error: null,
  };
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`px-1 pb-2 text-[11px] font-semibold tracking-wider text-zinc-400 uppercase ${className ?? ''}`}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-1 py-1.5">{children}</td>;
}
