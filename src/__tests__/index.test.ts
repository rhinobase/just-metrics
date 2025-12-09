import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createMetrics } from "../index";

const VALID_DSN = "https://abc123@o123456.ingest.sentry.io/4567890";

describe("createMetrics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("DSN parsing", () => {
    test("parses valid DSN correctly", () => {
      const metrics = createMetrics(VALID_DSN);
      expect(metrics).toBeDefined();
      expect(metrics.count).toBeInstanceOf(Function);
      expect(metrics.gauge).toBeInstanceOf(Function);
      expect(metrics.distribution).toBeInstanceOf(Function);
      expect(metrics.flush).toBeInstanceOf(Function);
    });

    test("throws on invalid DSN", () => {
      expect(() => createMetrics("invalid")).toThrow();
      expect(() => createMetrics("https://example.com")).toThrow(
        "Invalid DSN: missing required components",
      );
    });
  });

  describe("count", () => {
    test("creates counter metric with default value of 1", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      await metrics.flush();

      expect(fetch).toHaveBeenCalledTimes(1);
      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const lines = body.split("\n");
      const payload = JSON.parse(lines[2]);

      expect(payload.items).toHaveLength(1);
      expect(payload.items[0].name).toBe("test.metric");
      expect(payload.items[0].value).toBe(1);
      expect(payload.items[0].type).toBe("counter");
    });

    test("creates counter metric with custom value", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric", 5);
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);

      expect(payload.items[0].value).toBe(5);
    });

    test("includes attributes when provided", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric", 1, {
        attributes: { route: "/checkout", count: 42, active: true },
      });
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);
      const attributes = payload.items[0].attributes;

      expect(attributes.route).toEqual({ value: "/checkout", type: "string" });
      expect(attributes.count).toEqual({ value: 42, type: "integer" });
      expect(attributes.active).toEqual({ value: true, type: "boolean" });
    });
  });

  describe("gauge", () => {
    test("creates gauge metric", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.gauge("queue.depth", 42, { unit: "items" });
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);

      expect(payload.items[0].name).toBe("queue.depth");
      expect(payload.items[0].value).toBe(42);
      expect(payload.items[0].type).toBe("gauge");
      expect(payload.items[0].unit).toBe("items");
    });
  });

  describe("distribution", () => {
    test("creates distribution metric", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.distribution("response.time", 125.5, { unit: "millisecond" });
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);

      expect(payload.items[0].name).toBe("response.time");
      expect(payload.items[0].value).toBe(125.5);
      expect(payload.items[0].type).toBe("distribution");
      expect(payload.items[0].unit).toBe("millisecond");
    });
  });

  describe("envelope format", () => {
    test("builds correct envelope structure", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const lines = body.split("\n");

      expect(lines).toHaveLength(3);

      const header = JSON.parse(lines[0]);
      expect(header.dsn).toBe(VALID_DSN);
      expect(header.sent_at).toBeDefined();

      const itemHeader = JSON.parse(lines[1]);
      expect(itemHeader.type).toBe("trace_metric");
      expect(itemHeader.item_count).toBe(1);
      expect(itemHeader.content_type).toBe(
        "application/vnd.sentry.items.trace-metric+json",
      );

      const payload = JSON.parse(lines[2]);
      expect(payload.items).toBeInstanceOf(Array);
    });

    test("sends correct headers", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      await metrics.flush();

      const headers = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1]
        .headers;
      expect(headers["Content-Type"]).toBe("application/x-sentry-envelope");
      expect(headers["X-Sentry-Auth"]).toContain("sentry_key=abc123");
    });
  });

  describe("buffering", () => {
    test("auto-flushes after 5 seconds", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);

      expect(fetch).toHaveBeenCalledTimes(1);
    });

    test("auto-flushes when buffer reaches 100 items", async () => {
      const metrics = createMetrics(VALID_DSN);

      for (let i = 0; i < 100; i++) {
        metrics.count(`metric.${i}`);
      }

      // Should have flushed automatically
      expect(fetch).toHaveBeenCalledTimes(1);
      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);
      expect(payload.items).toHaveLength(100);
    });

    test("does not send empty buffer", async () => {
      const metrics = createMetrics(VALID_DSN);

      await metrics.flush();

      expect(fetch).not.toHaveBeenCalled();
    });

    test("clears buffer after flush", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      await metrics.flush();
      await metrics.flush();

      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("metric payload", () => {
    test("includes timestamp as epoch seconds", async () => {
      vi.setSystemTime(new Date("2024-01-15T10:00:00.000Z"));
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);

      expect(payload.items[0].timestamp).toBe(1705312800);
    });

    test("includes 32-char hex trace_id", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.count("test.metric");
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);

      expect(payload.items[0].trace_id).toMatch(/^[0-9a-f]{32}$/);
    });

    test("formats double attributes correctly", async () => {
      const metrics = createMetrics(VALID_DSN);

      metrics.distribution("cart.amount", 187.5, {
        attributes: { amount: 187.5 },
      });
      await metrics.flush();

      const body = (fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
      const payload = JSON.parse(body.split("\n")[2]);

      expect(payload.items[0].attributes.amount).toEqual({
        value: 187.5,
        type: "double",
      });
    });
  });
});
