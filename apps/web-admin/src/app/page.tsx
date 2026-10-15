import { ALL_ROLES, ROLE_LABELS, ROLE_PERMISSIONS, isPortfolioRole } from '@repo/types';
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@repo/ui';

/**
 * Placeholder shell for the staff dashboard.
 *
 * It renders the RBAC catalog straight out of @repo/types, which is a useful
 * smoke test of the workspace wiring: if the shared package is not linked or
 * not built, this page fails to compile rather than failing silently at
 * runtime.
 *
 * The real screens that replace this: reservation calendar (room x date grid),
 * folio management, arrivals/departures, housekeeping board, night audit
 * console, rate and restriction calendar.
 */
export default function AdminHomePage() {
  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">Operations</h1>
        <p className="text-muted-foreground">
          Property-scoped. Every request carries the active property, resolved server-side from the
          session.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-medium">Roles and permissions</h2>
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {ALL_ROLES.map((role) => (
            <Card key={role}>
              <CardHeader className="gap-2">
                <CardTitle className="flex items-center justify-between gap-2">
                  <span>{ROLE_LABELS[role]}</span>
                  <Badge variant={isPortfolioRole(role) ? 'warning' : 'secondary'}>
                    {isPortfolioRole(role) ? 'portfolio' : 'property'}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="tabular text-sm text-muted-foreground">
                  {ROLE_PERMISSIONS[role].length} permissions
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}
