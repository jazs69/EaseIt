'use client';

/**
 * Policies & terms.
 *
 * A cancellation policy is prose a guest reads *and* terms a cancellation path
 * has to apply, so both are captured: the text, and the two structured fields
 * — a free-cancellation window and a retention percentage — that code can
 * actually act on. Prose alone cannot be enforced; a percentage alone cannot
 * be shown to a guest.
 *
 * Policies are replaced as a set rather than edited row by row, because they
 * carry no natural key. Matching an edit to a row would mean matching on the
 * title, and renaming a policy would then add a second one beside the original
 * instead of changing it.
 */

import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { PropertyPolicy, PropertySetup } from '@repo/types';

import { Field, NotWiredNotice, SaveBar, Section, Select, TextArea, TextInput, Toggle } from './fields';
import type { PropertySettingsState } from './use-property-settings';

const POLICY_TYPES = [
  { value: 'CANCELLATION', label: 'Cancellation' },
  { value: 'AMENDMENT', label: 'Amendment' },
  { value: 'CHECK_IN_CHECK_OUT', label: 'Check-in and check-out' },
  { value: 'HOUSE_RULES', label: 'House rules' },
  { value: 'TERMS_AND_CONDITIONS', label: 'Terms and conditions' },
  { value: 'CUSTOM', label: 'Other' },
] as const;

interface PolicyDraft {
  key: string;
  type: PropertyPolicy['type'];
  title: string;
  content: string;
  isMandatory: boolean;
  freeCancellationHours: string;
  retentionChargePercent: string;
}

export function PoliciesTab({ state }: { state: PropertySettingsState }) {
  const { setup, saving, savedTab, savePolicies } = state;

  const [draft, setDraft] = useState<{ from: PropertySetup; value: PolicyDraft[] } | null>(
    null,
  );
  const policies =
    draft !== null && draft.from === setup ? draft.value : toDrafts(setup.policies);
  const dirty = JSON.stringify(policies) !== JSON.stringify(toDrafts(setup.policies));
  const [reason, setReason] = useState('');

  const parsed = policies.map(parsePolicy);
  const valid = parsed.every((row) => row.error === null);

  const setPolicies = (next: PolicyDraft[]) => {
    setDraft({ from: setup, value: next });
  };
  const patch = (index: number, change: Partial<PolicyDraft>) => {
    setPolicies(policies.map((policy, i) => (i === index ? { ...policy, ...change } : policy)));
  };

  return (
    <div className="flex flex-col gap-4">
      <Section
        title="Published policies"
        description="Shown to guests at booking and printed on confirmations."
        action={
          <SaveBar
            dirty={dirty && valid}
            saving={saving}
            saved={savedTab === 'policies'}
            onSave={() => {
              void savePolicies(
                parsed
                  .map((row) => row.policy)
                  .filter((policy): policy is NonNullable<typeof policy> => policy !== null),
                reason.trim() === '' ? null : reason.trim(),
              );
            }}
            onReset={() => {
              setDraft(null);
              setReason('');
            }}
          />
        }
      >
        {policies.length === 0 ? (
          <p className="text-xs text-zinc-500">No policies published.</p>
        ) : (
          <div className="flex flex-col gap-4">
            {policies.map((policy, index) => {
              const row = parsed[index];
              const structured =
                policy.type === 'CANCELLATION' || policy.type === 'AMENDMENT';

              return (
                <div
                  key={policy.key}
                  className="rounded-lg border border-white/[0.06] p-3"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Kind">
                      <Select
                        value={policy.type}
                        options={POLICY_TYPES}
                        disabled={saving}
                        onChange={(type) => {
                          patch(index, {
                            type,
                            // The structured terms only mean something for a
                            // cancellation or an amendment; carrying them on a
                            // house rule would imply an enforcement that is
                            // not there.
                            ...(type === 'CANCELLATION' || type === 'AMENDMENT'
                              ? {}
                              : { freeCancellationHours: '', retentionChargePercent: '' }),
                          });
                        }}
                      />
                    </Field>
                    <Field label="Title">
                      <TextInput
                        value={policy.title}
                        disabled={saving}
                        onChange={(title) => {
                          patch(index, { title });
                        }}
                      />
                    </Field>
                  </div>

                  <div className="mt-3">
                    <Field
                      label="What the guest is told"
                      error={row?.error ?? undefined}
                    >
                      <TextArea
                        value={policy.content}
                        disabled={saving}
                        rows={3}
                        onChange={(content) => {
                          patch(index, { content });
                        }}
                      />
                    </Field>
                  </div>

                  {structured ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <Field
                        label="Free until (hours before arrival)"
                        hint="Blank means no free window."
                      >
                        <TextInput
                          value={policy.freeCancellationHours}
                          disabled={saving}
                          inputMode="numeric"
                          onChange={(freeCancellationHours) => {
                            patch(index, { freeCancellationHours });
                          }}
                        />
                      </Field>
                      <Field
                        label="Retention charge %"
                        hint="How much of the tariff is kept inside the window."
                      >
                        <TextInput
                          value={policy.retentionChargePercent}
                          disabled={saving}
                          inputMode="decimal"
                          onChange={(retentionChargePercent) => {
                            patch(index, { retentionChargePercent });
                          }}
                        />
                      </Field>
                    </div>
                  ) : null}

                  <div className="mt-3 flex items-center justify-between gap-3">
                    <Toggle
                      checked={policy.isMandatory}
                      disabled={saving}
                      label="Guest must accept this to book"
                      onChange={(isMandatory) => {
                        patch(index, { isMandatory });
                      }}
                    />
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => {
                        setPolicies(policies.filter((_, i) => i !== index));
                      }}
                      className="flex items-center gap-1.5 text-xs font-medium text-zinc-500 transition-colors hover:text-rose-400 disabled:opacity-40"
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

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <button
            type="button"
            disabled={saving}
            onClick={() => {
              setPolicies([
                ...policies,
                {
                  key: `new-${String(Date.now())}`,
                  type: 'CUSTOM',
                  title: '',
                  content: '',
                  isMandatory: true,
                  freeCancellationHours: '',
                  retentionChargePercent: '',
                },
              ]);
            }}
            className="flex items-center gap-1.5 rounded-lg border border-white/[0.1] px-3 py-2 text-xs font-medium text-zinc-300 transition-colors hover:border-white/20 hover:text-white disabled:opacity-40"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add a policy
          </button>
          <div className="min-w-[16rem] flex-1">
            <Field
              label="Reason for the change"
              hint="Recorded in the audit trail beside the old and new text."
            >
              <TextInput
                value={reason}
                disabled={saving}
                placeholder="e.g. tightening the cancellation window for peak season"
                onChange={setReason}
              />
            </Field>
          </div>
        </div>

        <div className="mt-4">
          <NotWiredNotice>
            The structured terms are stored but not yet applied: no cancellation path
            reads them, because cancellation is not built. They are captured now so that
            when it is, the policy is already in the database rather than being invented
            at that point.
          </NotWiredNotice>
        </div>
      </Section>
    </div>
  );
}

function toDrafts(policies: readonly PropertyPolicy[]): PolicyDraft[] {
  return policies.map((policy) => ({
    key: policy.id,
    type: policy.type,
    title: policy.title,
    content: policy.content,
    isMandatory: policy.isMandatory,
    freeCancellationHours:
      policy.freeCancellationHours === null ? '' : String(policy.freeCancellationHours),
    retentionChargePercent:
      policy.retentionChargePercent === null ? '' : String(policy.retentionChargePercent),
  }));
}

function parsePolicy(draft: PolicyDraft): {
  policy: {
    type: PropertyPolicy['type'];
    title: string;
    content: string;
    isMandatory: boolean;
    freeCancellationHours: number | null;
    retentionChargePercent: number | null;
  } | null;
  error: string | null;
} {
  if (draft.title.trim() === '') return { policy: null, error: 'Give the policy a title.' };
  if (draft.content.trim() === '') {
    return { policy: null, error: 'A policy with no text tells a guest nothing.' };
  }

  const hours = draft.freeCancellationHours.trim();
  let freeCancellationHours: number | null = null;
  if (hours !== '') {
    if (!/^\d+$/.test(hours) || Number(hours) > 8760) {
      return { policy: null, error: 'The free window must be whole hours, up to 8760.' };
    }
    freeCancellationHours = Number(hours);
  }

  const retention = draft.retentionChargePercent.trim();
  let retentionChargePercent: number | null = null;
  if (retention !== '') {
    if (!/^\d+(\.\d{1,2})?$/.test(retention) || Number(retention) > 100) {
      return { policy: null, error: 'The retention charge must be a percentage, 0 to 100.' };
    }
    retentionChargePercent = Number(retention);
  }

  return {
    policy: {
      type: draft.type,
      title: draft.title.trim(),
      content: draft.content.trim(),
      isMandatory: draft.isMandatory,
      freeCancellationHours,
      retentionChargePercent,
    },
    error: null,
  };
}
