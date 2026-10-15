import { Card, CardContent, CardHeader, CardTitle } from '@repo/ui';

/**
 * The booking engine is always addressed per property. In production each
 * hotel is served from its own subdomain (`{slug}.book.yourdomain.com`); in
 * development the slug is the first path segment instead.
 *
 * This root page therefore has no property context of its own and exists only
 * to explain that.
 */
export default function BookingRootPage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-20">
      <Card>
        <CardHeader>
          <CardTitle>Choose a property</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
          <p>
            Each hotel has its own booking site. In development, open
            <code className="mx-1 rounded bg-muted px-1.5 py-0.5">/grand-marine-goa</code>
            or any other property slug.
          </p>
          <p>
            In production the slug is a subdomain and is resolved to a propertyId server-side — it
            is never trusted from a client header.
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
