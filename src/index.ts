type MetricType = "counter" | "gauge" | "distribution";
type AttributeValue = string | number | boolean;

interface MetricOptions {
  /** Unit of measurement (e.g., "millisecond", "items", "usd") */
  unit?: string;
  /** Key-value pairs attached to the metric */
  attributes?: Record<string, AttributeValue>;
}

export interface Metrics {
  /** Increment a counter metric (defaults to +1) */
  count: (name: string, value?: number, options?: MetricOptions) => void;
  /** Set a gauge value that can go up or down */
  gauge: (name: string, value: number, options?: MetricOptions) => void;
  /** Record a distribution value for percentiles, averages, etc. */
  distribution: (name: string, value: number, options?: MetricOptions) => void;
  /** Manually flush buffered metrics to Sentry */
  flush: () => Promise<void>;
}

/**
 * Creates a Sentry metrics client for sending counter, gauge, and distribution metrics.
 *
 * @param dsn - Sentry DSN (e.g., "https://key@org.ingest.sentry.io/project")
 * @returns Metrics object with count, gauge, distribution, and flush methods
 *
 * @example
 * ```ts
 * const metrics = createMetrics("https://key@org.ingest.sentry.io/123");
 * metrics.count("api.requests", 1, { attributes: { route: "/users" } });
 * metrics.gauge("queue.depth", 42, { unit: "items" });
 * metrics.distribution("response.time", 125.5, { unit: "millisecond" });
 * ```
 */
export function createMetrics(dsn: string): Metrics {
  const url = new URL(dsn);
  const publicKey = url.username;
  if (!publicKey || !url.host || !url.pathname.slice(1)) {
    throw new Error("Invalid DSN: missing required components");
  }
  const envelopeUrl = `https://${url.host}/api${url.pathname}/envelope/`;

  type Metric = {
    timestamp: number;
    trace_id: string;
    name: string;
    value: number;
    type: MetricType;
    unit?: string;
    attributes?: Record<string, { value: AttributeValue; type: string }>;
  };

  let buffer: Metric[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!buffer.length) return;

    const items = buffer;
    buffer = [];

    try {
      await fetch(envelopeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_key=${publicKey}, sentry_version=7`,
        },
        body: [
          JSON.stringify({ dsn, sent_at: new Date().toISOString() }),
          JSON.stringify({
            type: "trace_metric",
            item_count: items.length,
            content_type: "application/vnd.sentry.items.trace-metric+json",
          }),
          JSON.stringify({ items }),
        ].join("\n"),
      });
    } catch {}
  };

  const add = (
    name: string,
    value: number,
    type: MetricType,
    options?: MetricOptions
  ): void => {
    const metric: Metric = {
      timestamp: Date.now() / 1000,
      trace_id: crypto.randomUUID().replace(/-/g, ""),
      name,
      value,
      type,
    };

    if (options?.unit) metric.unit = options.unit;
    if (options?.attributes) {
      metric.attributes = {};
      for (const [k, v] of Object.entries(options.attributes)) {
        const t = typeof v;
        metric.attributes[k] = {
          value: v,
          type:
            t === "number" ? (Number.isInteger(v) ? "integer" : "double") : t,
        };
      }
    }

    buffer.push(metric);
    if (buffer.length >= 100) flush();
    else if (!timer) timer = setTimeout(flush, 5000);
  };

  return {
    count: (name, value = 1, options?) => add(name, value, "counter", options),
    gauge: (name, value, options?) => add(name, value, "gauge", options),
    distribution: (name, value, options?) =>
      add(name, value, "distribution", options),
    flush,
  };
}
