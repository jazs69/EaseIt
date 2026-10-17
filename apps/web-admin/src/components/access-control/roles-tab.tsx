'use client';

import { cn } from '@repo/ui';
import { Permission, type Permission as PermissionKey } from '@repo/types';
import { Lock, Pencil, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useHasPermission, usePermissions } from '@/hooks/use-has-permission';
import { Modal } from './modal';
import { PermissionMatrix } from './permission-matrix';
import type { RoleView } from './fixtures';

export interface RolesTabProps {
  roles: readonly RoleView[];
  onCreate: (role: { name: string; description: string; permissions: PermissionKey[] }) => void;
  onUpdate: (
    roleId: string,
    changes: { name: string; description: string; permissions: PermissionKey[] },
  ) => void;
}

interface EditorState {
  mode: 'create' | 'edit';
  roleId: string | null;
  name: string;
  description: string;
  selected: Set<PermissionKey>;
}

function RoleCard({
  role,
  canManage,
  onEdit,
}: {
  role: RoleView;
  canManage: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-white/[0.08] bg-white/[0.02] p-4 transition-colors hover:border-blue-500/30">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-white">{role.name}</h3>
            {role.isCustom ? (
              <span className="rounded-full border border-blue-400/25 bg-blue-500/10 px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-blue-300 uppercase">
                Custom
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 text-[9px] font-semibold tracking-wider text-zinc-500 uppercase">
                <Lock className="size-2.5" aria-hidden="true" />
                System
              </span>
            )}
          </div>
          <p className="line-clamp-2 text-xs leading-relaxed text-zinc-500">{role.description}</p>
        </div>

        <button
          type="button"
          onClick={onEdit}
          disabled={!canManage || !role.isCustom}
          title={
            !role.isCustom
              ? 'System templates are shared by every property and cannot be edited'
              : !canManage
                ? 'Requires the Manage roles permission'
                : 'Edit this role'
          }
          className="ml-auto grid size-8 shrink-0 place-items-center rounded-lg border border-white/[0.08] bg-white/[0.02] text-zinc-400 transition-colors hover:border-blue-500/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Pencil className="size-3.5" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-auto flex items-center gap-3 border-t border-white/[0.06] pt-3">
        <span className="tabular text-[11px] text-zinc-400">
          {role.permissions.length} permissions
        </span>
        <span className="inline-flex items-center gap-1 text-[11px] text-zinc-600">
          <Users className="size-3" aria-hidden="true" />
          <span className="tabular">{role.assignedCount}</span> assigned
        </span>
      </div>
    </div>
  );
}

export function RolesTab({ roles, onCreate, onUpdate }: RolesTabProps) {
  const canManageRoles = useHasPermission(Permission.ROLES_MANAGE);
  const myPermissions = usePermissions();
  const [editor, setEditor] = useState<EditorState | null>(null);

  // An administrator cannot grant what they do not hold. The server enforces
  // this too (AccessControlService.assertCanGrant); showing it here just
  // avoids a confusing rejection after the fact.
  const ungrantable = useMemo(() => {
    const blocked = new Set<PermissionKey>();
    for (const permission of Object.values(Permission)) {
      if (!myPermissions.includes(permission)) blocked.add(permission);
    }
    return blocked;
  }, [myPermissions]);

  function openCreate(): void {
    setEditor({
      mode: 'create',
      roleId: null,
      name: '',
      description: '',
      selected: new Set<PermissionKey>(),
    });
  }

  function openEdit(role: RoleView): void {
    setEditor({
      mode: 'edit',
      roleId: role.id,
      name: role.name,
      description: role.description,
      selected: new Set(role.permissions),
    });
  }

  function commit(): void {
    if (editor === null) return;
    const payload = {
      name: editor.name.trim(),
      description: editor.description.trim(),
      permissions: [...editor.selected],
    };
    if (payload.name.length < 2 || payload.permissions.length === 0) return;

    if (editor.mode === 'create') {
      onCreate(payload);
    } else if (editor.roleId !== null) {
      onUpdate(editor.roleId, payload);
    }
    setEditor(null);
  }

  const valid = editor !== null && editor.name.trim().length >= 2 && editor.selected.size > 0;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-zinc-500">
          System templates are shared across the portfolio and read-only. Create a custom role to
          combine duties for this property.
        </p>
        <button
          type="button"
          onClick={openCreate}
          disabled={!canManageRoles}
          title={canManageRoles ? undefined : 'Requires the Manage roles permission'}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-3 py-2 text-xs font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          New custom role
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {roles.map((role) => (
          <RoleCard
            key={role.id}
            role={role}
            canManage={canManageRoles}
            onEdit={() => {
              openEdit(role);
            }}
          />
        ))}
      </div>

      <Modal
        open={editor !== null}
        onClose={() => {
          setEditor(null);
        }}
        title={editor?.mode === 'create' ? 'New custom role' : 'Edit custom role'}
        description="Toggle the exact actions this role may perform. Permissions you do not hold yourself cannot be granted."
        className="max-w-3xl"
        footer={
          <>
            <button
              type="button"
              onClick={() => {
                setEditor(null);
              }}
              className="rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-xs text-zinc-300 transition-colors hover:border-white/20 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={commit}
              disabled={!valid}
              className="rounded-lg bg-white px-3 py-2 text-xs font-medium text-black transition hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editor?.mode === 'create' ? 'Create role' : 'Save changes'}
            </button>
          </>
        }
      >
        {editor !== null ? (
          <div className="flex flex-col gap-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">Role name</span>
                <input
                  value={editor.name}
                  onChange={(event) => {
                    setEditor({ ...editor, name: event.target.value });
                  }}
                  placeholder="Front Desk &amp; Night Auditor"
                  className={cn(
                    'w-full rounded-lg border bg-zinc-900/60 px-3 py-2 text-sm text-white placeholder:text-zinc-600',
                    'border-white/10 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none',
                  )}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-300">Description</span>
                <input
                  value={editor.description}
                  onChange={(event) => {
                    setEditor({ ...editor, description: event.target.value });
                  }}
                  placeholder="What this role is for"
                  className="w-full rounded-lg border border-white/10 bg-zinc-900/60 px-3 py-2 text-sm text-white placeholder:text-zinc-600 focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
              <span className="text-xs text-zinc-400">
                <span className="tabular font-semibold text-white">{editor.selected.size}</span>{' '}
                permissions selected
              </span>
              <button
                type="button"
                onClick={() => {
                  setEditor({ ...editor, selected: new Set<PermissionKey>() });
                }}
                className="text-[11px] text-zinc-500 transition-colors hover:text-white"
              >
                Clear all
              </button>
            </div>

            <PermissionMatrix
              selected={editor.selected}
              ungrantable={ungrantable}
              onToggle={(permission, next) => {
                const selected = new Set(editor.selected);
                if (next) {
                  selected.add(permission);
                } else {
                  selected.delete(permission);
                }
                setEditor({ ...editor, selected });
              }}
            />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
