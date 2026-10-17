'use client';

import { cn } from '@repo/ui';
import { Permission, type Permission as PermissionKey } from '@repo/types';
import { ShieldCheck, TriangleAlert, Users } from 'lucide-react';
import { useState } from 'react';

import { useHasPermission } from '@/hooks/use-has-permission';
import {
  initialCustomRoles,
  initialStaff,
  systemRoles,
  type RoleView,
  type StaffView,
} from './fixtures';
import { RolesTab } from './roles-tab';
import { StaffTab } from './staff-tab';

type TabId = 'staff' | 'roles';

const TABS: readonly { id: TabId; label: string; icon: typeof Users }[] = [
  { id: 'staff', label: 'Staff Directory', icon: Users },
  { id: 'roles', label: 'Roles & Permissions', icon: ShieldCheck },
];

/**
 * Access-control settings.
 *
 * All mutations below are React state only — see ./fixtures.ts. Nothing is
 * persisted, because the database does not exist yet. The permission checks
 * driving what is enabled are real, and are mirrored server-side by
 * `PermissionsGuard`.
 */
export function AccessControlView() {
  const [tab, setTab] = useState<TabId>('staff');
  const [customRoles, setCustomRoles] = useState<RoleView[]>(initialCustomRoles);
  const [staff, setStaff] = useState<StaffView[]>(initialStaff);

  const canRead = useHasPermission(Permission.USERS_READ);
  const roles: RoleView[] = [...systemRoles(), ...customRoles];

  // Recompute the assigned counts from the live staff list rather than storing
  // them, so the numbers cannot drift from the grants.
  const rolesWithCounts = roles.map((role) => ({
    ...role,
    assignedCount: staff.filter((member) => member.roleIds.includes(role.id)).length,
  }));

  if (!canRead) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-4 py-3.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-amber-200">
          You do not have permission to view staff or roles at this property. Ask a Property Admin
          for the <code>users:read</code> permission.
        </p>
      </div>
    );
  }

  function handleCreateRole(input: {
    name: string;
    description: string;
    permissions: PermissionKey[];
  }): void {
    setCustomRoles((previous) => [
      ...previous,
      {
        id: `custom:${String(Date.now())}`,
        name: input.name,
        description: input.description,
        key: null,
        isCustom: true,
        permissions: input.permissions,
        assignedCount: 0,
      },
    ]);
  }

  function handleUpdateRole(
    roleId: string,
    changes: { name: string; description: string; permissions: PermissionKey[] },
  ): void {
    setCustomRoles((previous) =>
      previous.map((role) => (role.id === roleId ? { ...role, ...changes } : role)),
    );
  }

  function handleAssignRoles(userId: string, roleIds: string[]): void {
    setStaff((previous) =>
      previous.map((member) => (member.id === userId ? { ...member, roleIds } : member)),
    );
  }

  function handleInvite(member: {
    email: string;
    firstName: string;
    lastName: string;
    roleIds: string[];
  }): void {
    setStaff((previous) => [
      ...previous,
      {
        id: `u-${String(Date.now())}`,
        email: member.email,
        firstName: member.firstName,
        lastName: member.lastName,
        isActive: true,
        roleIds: member.roleIds,
      },
    ]);
  }

  return (
    <div className="flex flex-col gap-6">
      <div
        role="note"
        className="flex items-start gap-3 rounded-xl border border-amber-400/20 bg-amber-500/[0.05] px-4 py-3"
      >
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-400" aria-hidden="true" />
        <p className="text-xs leading-relaxed text-amber-200/80">
          <span className="font-medium text-amber-200">Local preview.</span> Roles come from the
          shared RBAC definitions, but staff data is a fixture and edits are not saved — the
          database has not been migrated yet.
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-white/[0.08]">
        {TABS.map((item) => {
          const Icon = item.icon;
          const active = tab === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setTab(item.id);
              }}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-2 border-b-2 px-4 py-2.5 text-sm transition-colors',
                active
                  ? 'border-blue-500 text-white'
                  : 'border-transparent text-zinc-500 hover:text-zinc-300',
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              {item.label}
            </button>
          );
        })}
      </div>

      {tab === 'staff' ? (
        <StaffTab
          staff={staff}
          roles={rolesWithCounts}
          onAssignRoles={handleAssignRoles}
          onInvite={handleInvite}
        />
      ) : (
        <RolesTab roles={rolesWithCounts} onCreate={handleCreateRole} onUpdate={handleUpdateRole} />
      )}
    </div>
  );
}
