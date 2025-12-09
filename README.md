# Just Metrics

A lightweight Sentry metrics SDK for sending metrics.

## Installation

```bash
npm install just-metrics
```

## Usage

```ts
import { createMetrics } from "just-metrics";

const metrics = createMetrics("SENTRY_DSN");

metrics.count("just-metrics.count", 1);
metrics.distribution("just-metrics.distribution", 1);
metrics.gauge("just-metrics.gauge", 1);
```

### With options

```ts
metrics.count("checkout.failed", 1, {
  attributes: {
    route: "/checkout",
    tenant: "acme",
  },
});

metrics.gauge("queue.depth", 42, {
  unit: "items",
  attributes: {
    queue: "emails",
  },
});

metrics.distribution("response.time", 125.5, {
  unit: "millisecond",
  attributes: {
    endpoint: "/api/users",
  },
});
```

### Manual flush

Metrics are automatically buffered and flushed every 5 seconds or when 100 items accumulate. You can also flush manually:

```ts
await metrics.flush();
```