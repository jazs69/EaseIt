import { format, money } from '@repo/types';
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from '@repo/ui';

/**
 * Per-property booking entry point.
 *
 * The slug arrives from the URL and is resolved to a `propertyId` on the
 * server before any query runs (CLAUDE.md section 3.2). Until the properties
 * module exists this page renders placeholder content, but the shape of the
 * boundary is already the real one: the slug is a lookup key, never an
 * assertion of access.
 *
 * It also exercises the shared Money helpers so the integer-minor-unit rule
 * is visible from the very first screen: 1250000 paise, not 12500.00 rupees
 * (CLAUDE.md section 3.4).
 */
export default async function PropertyBookingPage({
  params,
}: {
  params: Promise<{ propertySlug: string }>;
}) {
  const { propertySlug } = await params;

  // Placeholder nightly rate: stored and passed around as integer minor units.
  const nightlyRate = money(1_250_000, 'INR');

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <Badge variant="secondary" className="w-fit">
          {propertySlug}
        </Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Book direct</h1>
        <p className="text-muted-foreground">Best available rate, no booking fee.</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Deluxe King</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="tabular text-2xl font-semibold">{format(nightlyRate)}</span>
            <span className="text-sm text-muted-foreground">per night, taxes extra</span>
          </div>
          <Button disabled>Select dates</Button>
        </CardContent>
      </Card>
    </main>
  );
}
