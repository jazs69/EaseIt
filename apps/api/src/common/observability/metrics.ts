/**
 * A small Prometheus registry (OB-05): counters, gauges and histograms in the
 * text exposition format 0.0.4, with no client library.
 *
 * Enough for this platform's scale (ten properties, one API process or a few):
 * label sets are bounded by construction (route TEMPLATES, never raw URLs;
 * provider names; status codes), so memory cannot grow with traffic. Values
 * are per process; Prometheus sums across replicas.
 */

type Labels = Record<string, string>;

function key(labels: Labels): string {
  return Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k] ?? ''}`)
    .join(',');
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function renderLabels(labels: Labels, extra: Labels = {}): string {
  const all = { ...labels, ...extra };
  const parts = Object.keys(all)
    .sort()
    .map((k) => `${k}="${escapeLabel(all[k] ?? '')}"`);
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

function number(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return '+Inf';
  return String(value);
}

interface Metric {
  render(): string;
}

export class Counter implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels);
    const entry = this.values.get(k) ?? { labels, value: 0 };
    entry.value += by;
    this.values.set(k, entry);
  }

  get(labels: Labels = {}): number {
    return this.values.get(key(labels))?.value ?? 0;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${number(value)}`);
    }
    return lines.join('\n');
  }
}

export class Gauge implements Metric {
  private readonly values = new Map<string, { labels: Labels; value: number }>();
  constructor(
    readonly name: string,
    readonly help: string,
  ) {}

  set(value: number, labels: Labels = {}): void {
    this.values.set(key(labels), { labels, value });
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} gauge`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabels(labels)} ${number(value)}`);
    }
    return lines.join('\n');
  }
}

export class Histogram implements Metric {
  private readonly series = new Map<
    string,
    { labels: Labels; counts: number[]; sum: number; count: number }
  >();
  constructor(
    readonly name: string,
    readonly help: string,
    readonly buckets: readonly number[],
  ) {}

  observe(value: number, labels: Labels = {}): void {
    const k = key(labels);
    const entry = this.series.get(k) ?? {
      labels,
      counts: this.buckets.map(() => 0),
      sum: 0,
      count: 0,
    };
    this.buckets.forEach((bound, i) => {
      if (value <= bound) entry.counts[i] = (entry.counts[i] ?? 0) + 1;
    });
    entry.sum += value;
    entry.count += 1;
    this.series.set(k, entry);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum, count } of this.series.values()) {
      this.buckets.forEach((bound, i) => {
        lines.push(
          `${this.name}_bucket${renderLabels(labels, { le: number(bound) })} ${String(counts[i] ?? 0)}`,
        );
      });
      lines.push(`${this.name}_bucket${renderLabels(labels, { le: '+Inf' })} ${String(count)}`);
      lines.push(`${this.name}_sum${renderLabels(labels)} ${number(sum)}`);
      lines.push(`${this.name}_count${renderLabels(labels)} ${String(count)}`);
    }
    return lines.join('\n');
  }
}

export function renderAll(metrics: readonly Metric[]): string {
  return `${metrics.map((metric) => metric.render()).join('\n')}\n`;
}
