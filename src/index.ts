type MetricType = "counter" | "gauge" | "distribution";

type AttributeValue = string | number | boolean;

type Attributes = Record<string, AttributeValue>;

interface MetricOptions {
  unit?: string;
  attributes?: Attributes;
}

interface FormattedAttribute {
  value: AttributeValue;
  type: "string" | "integer" | "double" | "boolean";
}

interface MetricPayload {
  timestamp: number;
  trace_id: string;
  name: string;
  value: number;
  type: MetricType;
  unit?: string;
  attributes?: Record<string, FormattedAttribute>;
}

interface ParsedDSN {
  publicKey: string;
  host: string;
  projectId: string;
}

export interface Metrics {
  count: (name: string, value?: number, options?: MetricOptions) => void;
  gauge: (name: string, value: number, options?: MetricOptions) => void;
  distribution: (name: string, value: number, options?: MetricOptions) => void;
  flush: () => Promise<void>;
}

const BUFFER_SIZE_LIMIT = 100;
const FLUSH_INTERVAL_MS = 5000;

function parseDSN(dsn: string): ParsedDSN {
  const url = new URL(dsn);
  const publicKey = url.username;
  const host = url.host;
  const projectId = url.pathname.slice(1); // Remove leading "/"

  if (!publicKey || !host || !projectId) {
    throw new Error("Invalid DSN: missing required components");
  }

  return { publicKey, host, projectId };
}

function generateTraceId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function formatAttributeValue(value: AttributeValue): FormattedAttribute {
  const typeOfValue = typeof value;

  switch (typeOfValue) {
    case "string":
      return { value, type: "string" };
    case "boolean":
      return { value, type: "boolean" };
    case "number":
      return Number.isInteger(value)
        ? { value, type: "integer" }
        : { value, type: "double" };
    default:
      return { value: String(value), type: "string" };
  }
}

function formatAttributes(
  attributes?: Attributes,
): Record<string, FormattedAttribute> | undefined {
  if (!attributes) return undefined;

  const formatted: Record<string, FormattedAttribute> = {};
  for (const [key, value] of Object.entries(attributes)) {
    formatted[key] = formatAttributeValue(value);
  }
  return formatted;
}

export function createMetrics(dsn: string): Metrics {
  const { publicKey, host, projectId } = parseDSN(dsn);
  const envelopeUrl = `https://${host}/api/${projectId}/envelope/`;

  let buffer: MetricPayload[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleFlush(): void {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flush();
    }, FLUSH_INTERVAL_MS);
  }

  function createMetric(
    name: string,
    value: number,
    type: MetricType,
    options?: MetricOptions,
  ): void {
    const metric: MetricPayload = {
      timestamp: Date.now() / 1000,
      trace_id: generateTraceId(),
      name,
      value,
      type,
    };

    if (options?.unit) {
      metric.unit = options.unit;
    }

    const formattedAttributes = formatAttributes(options?.attributes);
    if (formattedAttributes) {
      metric.attributes = formattedAttributes;
    }

    buffer.push(metric);

    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush();
    } else {
      scheduleFlush();
    }
  }

  async function flush(): Promise<void> {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (buffer.length === 0) return;

    const metricsToSend = buffer;
    buffer = [];

    const envelope = buildEnvelope(metricsToSend);

    try {
      await fetch(envelopeUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          "X-Sentry-Auth": `Sentry sentry_key=${publicKey}, sentry_version=7`,
        },
        body: envelope,
      });
    } catch {
      // Silently fail - metrics are best-effort
    }
  }

  function buildEnvelope(metrics: MetricPayload[]): string {
    const header = JSON.stringify({
      dsn,
      sent_at: new Date().toISOString(),
    });

    const itemHeader = JSON.stringify({
      type: "trace_metric",
      item_count: metrics.length,
      content_type: "application/vnd.sentry.items.trace-metric+json",
    });

    const itemPayload = JSON.stringify({ items: metrics });

    return `${header}\n${itemHeader}\n${itemPayload}`;
  }

  return {
    count(name: string, value = 1, options?: MetricOptions): void {
      createMetric(name, value, "counter", options);
    },

    gauge(name: string, value: number, options?: MetricOptions): void {
      createMetric(name, value, "gauge", options);
    },

    distribution(name: string, value: number, options?: MetricOptions): void {
      createMetric(name, value, "distribution", options);
    },

    flush,
  };
}
