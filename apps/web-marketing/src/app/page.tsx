import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@repo/ui';

const PILLARS = [
  {
    title: 'Property Management',
    body: 'Reservation calendar, front desk, folios, housekeeping and a deterministic night audit.',
  },
  {
    title: 'Channel Manager',
    body: 'Two-way availability, rate and inventory sync with the OTAs, with a full push audit trail.',
  },
  {
    title: 'Direct Booking Engine',
    body: 'A fast, SEO-indexed booking site per property. No per-reservation commission.',
  },
] as const;

export default function MarketingHomePage() {
  const bookingUrl = process.env['NEXT_PUBLIC_BOOKING_URL'] ?? 'http://localhost:3002';
  const adminUrl = process.env['NEXT_PUBLIC_ADMIN_URL'] ?? 'http://localhost:3001';

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-16 px-6 py-20">
      <section className="flex flex-col gap-6">
        <Badge variant="secondary" className="w-fit">
          Built for a 10-property portfolio
        </Badge>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight sm:text-5xl">
          Run every hotel in the group from one system.
        </h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          EaseIt combines the PMS, the channel manager and the direct booking engine so your front
          desk, revenue team and night auditor all work off the same numbers.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button asChild>
            <a href={bookingUrl}>Book a stay</a>
          </Button>
          <Button variant="outline" asChild>
            <a href={adminUrl}>Staff sign in</a>
          </Button>
        </div>
      </section>

      <section className="grid gap-6 sm:grid-cols-3">
        {PILLARS.map((pillar) => (
          <Card key={pillar.title}>
            <CardHeader>
              <CardTitle>{pillar.title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">{pillar.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>
    </main>
  );
}
