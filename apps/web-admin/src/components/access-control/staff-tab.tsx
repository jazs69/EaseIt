'use client';

import { cn } from '@repo/ui';
import { Permission, type Permission as PermissionKey } from '@repo/types';
import { Search, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useHasPermission } from '@/hooks/use-has-permission';
import { Modal } from './modal';
import { permissionsFor, type RoleView, type StaffView } from './fixtures';

export interface StaffTabProps {
  staff: readonly StaffView[];
  roles: readonly RoleView[];
  onAssignRoles: (userId: string, roleIds: string[]) => void;
  onInvite: (member: {
    email: string;
    firstName: string;
    lastName: string;
    roleIds: string[];
  }) => void;
}

/** Glowing pill for an assigned role. Custom roles read blue, system neutral. */
function RolePill({ role }: { role: RoleView }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
        role.isCustom
          ? 'border-blue-400/30 bg-blue-500/15 text-blue-200 shadow-[0_0_12px_-4px_rgba(59,130,246,0.8)]'
          : 'border-white/[0.1] bg-white/[0.04] text-zinc-300',
      )}
    >
      {role.name}
    </span>
  );
}

interface RoleCheckboxListProps {
  roles: readonly RoleView[];
  selected: ReadonlySet<string>;
  onToggle: (roleId: string, next: boolean) => void;
}

function RoleCheckboxList({ roles, selected, onToggle }: RoleCheckboxListProps) {
  return (
    <div className="grid gap-1 sm:grid-cols-2">
      {roles.map((role) => {
        const inputId = `role-${role.id.replace(/[:]/g, '-')}`;
        return (
          <label
            key={role.id}
            htmlFor={inputId}
            className="flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-white/[0.03]"
          >
            <input
              id={inputId}
              type="checkbox"
              checked={selected.has(role.id)}
              onChange={(event) => {
                onToggle(role.id, event.target.checked);
              }}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="mt-0.5 grid size-4 shrink-0 place-items-center rounded border border-white/15 bg-zinc-900/60 transition-colors peer-checked:border-blue-500 peer-checked:bg-blue-500 peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500/50 peer-checked:[&>svg]:scale-100"
            >
              <svg
                viewBox="0 0 12 12"
                className="size-3 scale-0 text-white transition-transform"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M2.5 6.5 5 9l4.5-5.5" />
              </svg>
            </span>
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm text-zinc-200">{role.name}</span>
              <span className="tabular text-[10px] text-zinc-600">
                {role.permissions.length} permissions
              </span>
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function StaffTab({ staff, roles, onAssignRoles, onInvite }: StaffTabProps) {
  const canManageUsers = useHasPermission(Permission.USERS_MANAGE);

  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<{ user: StaffView; selected: Set<string> } | null>(null);
  const [inviting, setInviting] = useState<{
    email: string;
    firstName: string;
    lastName: string;
    selected: Set<string>;
  } | null>(null);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (needle.length === 0) return staff;
    return staff.filter((member) =>
      `${member.firstName} ${member.lastName} ${member.email}`.toLowerCase().includes(needle),
    );
  }, [staff, search]);

  const roleById = useMemo(() => new Map(roles.map((role) => [role.id, role])), [roles]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500"
            aria-hidden="true"
          />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
            placeholder="Search staff by name or email"
            className="w-full rounded-lg border border-white/10 bg-zinc-900/60 py-2 pr-3 pl-9 text-sm text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
          />
        </div>
        <button
          type="button"
          disabled={!canManageUsers}
          title={canManageUsers ? undefined : 'Requires the Manage staff permission'}
          onClick={() => {
            setInviting({
              email: '',
              firstName: '',
              lastName: '',
              selected: new Set<string>(),
            });
          }}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <UserPlus className="size-3.5" aria-hidden="true" />
          Invite staff
        </button>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/[0.08]">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-white/[0.08] bg-white/[0.02]">
              <th className="px-4 py-3 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
                Staff member
              </th>
              <th className="hidden px-4 py-3 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase md:table-cell">
                Roles
              </th>
              <th className="hidden px-4 py-3 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase lg:table-cell">
                Permissions
              </th>
              <th className="px-4 py-3 text-[10px] font-semibold tracking-[0.16em] text-zinc-500 uppercase">
                Status
              </th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((member) => {
              const assigned = member.roleIds
                .map((roleId) => roleById.get(roleId))
                .filter((role): role is RoleView => role !== undefined);
              const permissionCount = permissionsFor(member.roleIds, roles).length;

              return (
                <tr
                  key={member.id}
                  className="border-b border-white/[0.05] last:border-b-0 hover:bg-white/[0.015]"
                >
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium text-white">
                        {member.firstName} {member.lastName}
                      </span>
                      <span className="truncate text-[11px] text-zinc-500">{member.email}</span>
                      <div className="mt-1 flex flex-wrap gap-1 md:hidden">
                        {assigned.map((role) => (
                          <RolePill key={role.id} role={role} />
                        ))}
                      </div>
                    </div>
                  </td>
                  <td className="hidden px-4 py-3 md:table-cell">
                    <div className="flex flex-wrap gap-1">
                      {assigned.length === 0 ? (
                        <span className="text-[11px] text-zinc-600">No roles</span>
                      ) : (
                        assigned.map((role) => <RolePill key={role.id} role={role} />)
                      )}
                    </div>
                  </td>
                  <td className="tabular hidden px-4 py-3 text-xs text-zinc-500 lg:table-cell">
                    {permissionCount}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium',
                        member.isActive
                          ? 'border-emerald-400/25 bg-emerald-500/10 text-emerald-300'
                          : 'border-zinc-600/40 bg-zinc-700/20 text-zinc-500',
                      )}
                    >
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          member.isActive ? 'bg-emerald-400' : 'bg-zinc-500',
                        )}
                        aria-hidden="true"
                      />
                      {member.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      disabled={!canManageUsers}
                      onClick={() => {
                        setEditing({ user: member, selected: new Set(member.roleIds) });
                      }}
                      className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-2.5 py-1.5 text-[11px] text-zinc-300 transition-colors hover:border-blue-500/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Edit roles
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-zinc-600">No staff match “{search}”.</p>
        ) : null}
      </div>

      {/* Assign roles */}
      <Modal
        open={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        title={
          editing === null
            ? 'Assign roles'
            : `Roles for ${editing.user.firstName} ${editing.user.lastName}`
        }
        description="A staff member may hold several roles at one property; their permissions are the union of all of them."
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
              }}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                if (editing === null) return;
                onAssignRoles(editing.user.id, [...editing.selected]);
                setEditing(null);
              }}
              className="rounded-lg bg-white px-3 py-2 text-xs font-medium text-black transition hover:bg-zinc-200"
            >
              Save roles
            </button>
          </>
        }
      >
        {editing !== null ? (
          <div className="flex flex-col gap-4">
            <p className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-xs text-zinc-500">
              Clearing every role removes this person from the property directory without
              deactivating their account.
            </p>
            <RoleCheckboxList
              roles={roles}
              selected={editing.selected}
              onToggle={(roleId, next) => {
                const selected = new Set(editing.selected);
                if (next) selected.add(roleId);
                else selected.delete(roleId);
                setEditing({ ...editing, selected });
              }}
            />
            <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <span className="tabular text-xs text-zinc-400">
                Effective permissions:{' '}
                <span className="font-semibold text-white">
                  {permissionsFor([...editing.selected], roles).length}
                </span>
              </span>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* Invite */}
      <Modal
        open={inviting !== null}
        onClose={() => {
          setInviting(null);
        }}
        title="Invite staff"
        description="They receive a single-use link to set a password. Roles apply to this property only."
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setInviting(null);
              }}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                inviting === null ||
                !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(inviting.email) ||
                inviting.firstName.trim().length === 0 ||
                inviting.selected.size === 0
              }
              onClick={() => {
                if (inviting === null) return;
                onInvite({
                  email: inviting.email.trim().toLowerCase(),
                  firstName: inviting.firstName.trim(),
                  lastName: inviting.lastName.trim(),
                  roleIds: [...inviting.selected],
                });
                setInviting(null);
              }}
              className="rounded-lg bg-white px-3 py-2 text-xs font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Send invite
            </button>
          </>
        }
      >
        {inviting !== null ? (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">First name</span>
                <input
                  value={inviting.firstName}
                  onChange={(event) => {
                    setInviting({ ...inviting, firstName: event.target.value });
                  }}
                  className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">Last name</span>
                <input
                  value={inviting.lastName}
                  onChange={(event) => {
                    setInviting({ ...inviting, lastName: event.target.value });
                  }}
                  className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
              </label>
            </div>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-zinc-300">Work email</span>
              <input
                type="email"
                value={inviting.email}
                onChange={(event) => {
                  setInviting({ ...inviting, email: event.target.value });
                }}
                placeholder="name@yourhotel.com"
                className="rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
              />
            </label>
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium text-zinc-300">Assign roles</span>
              <RoleCheckboxList
                roles={roles}
                selected={inviting.selected}
                onToggle={(roleId, next) => {
                  const selected = new Set(inviting.selected);
                  if (next) selected.add(roleId);
                  else selected.delete(roleId);
                  setInviting({ ...inviting, selected });
                }}
              />
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}

export type { PermissionKey };
