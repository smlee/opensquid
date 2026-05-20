/**
 * OBSERVE.1 — OpenTelemetry OTLP/JSON export.
 *
 * Subset of the OTLP/JSON trace format (spec:
 * https://opentelemetry.io/docs/specs/otel/protocol/otlp/#otlpjson) —
 * enough for AgentOps / LangSmith / Jaeger to import a single run's
 * timeline as a trace with one span per primitive call.
 *
 * ID derivation (locked):
 *
 *   trace_id  =  sha256(runId).slice(0, 32)              // 16 bytes / 32 hex
 *   span_id   =  sha256(runId + ':' + stepIdx).slice(0, 16)  // 8 bytes / 16 hex
 *
 * Hex-string IDs satisfy the OTLP/JSON encoding spec (the binary protocol
 * uses raw bytes; the JSON encoding uses hex strings).
 *
 * Imports from: node:crypto, ./trace_types.js.
 * Imported by: ./trace_reader.ts.
 */

import { createHash } from 'node:crypto';

import type { TraceTimeline } from './trace_types.js';

interface OtelAttrValue {
  stringValue?: string;
  intValue?: string;
}

interface OtelAttr {
  key: string;
  value: OtelAttrValue;
}

interface OtelSpan {
  trace_id: string;
  span_id: string;
  name: string;
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'; message?: string };
  attributes: OtelAttr[];
}

export interface OtelExport {
  resourceSpans: {
    resource: { attributes: OtelAttr[] };
    scopeSpans: { scope: { name: string; version: string }; spans: OtelSpan[] }[];
  }[];
}

/** Convert a TraceTimeline to OTLP/JSON. trace_id = 32 hex; span_id = 16 hex. */
export function toOtel(t: TraceTimeline): OtelExport {
  const traceId = sha256Hex(t.runId).slice(0, 32);
  const spans: OtelSpan[] = t.events.map((e) => {
    const span: OtelSpan = {
      trace_id: traceId,
      span_id: sha256Hex(`${t.runId}:${e.stepIdx}`).slice(0, 16),
      name: e.fn,
      start_time_unix_nano: msToUnixNanoString(e.startedAtMs),
      end_time_unix_nano: msToUnixNanoString(e.completedAtMs),
      status:
        e.status === 'completed'
          ? { code: 'STATUS_CODE_OK' }
          : { code: 'STATUS_CODE_ERROR', message: e.errorMessage ?? '' },
      attributes: [
        { key: 'opensquid.step_idx', value: { intValue: e.stepIdx.toString() } },
        { key: 'opensquid.inputs_hash', value: { stringValue: e.inputsHash } },
      ],
    };
    if (e.asBinding !== undefined) {
      span.attributes.push({ key: 'opensquid.as', value: { stringValue: e.asBinding } });
    }
    if (e.outputsPreview !== undefined) {
      span.attributes.push({
        key: 'opensquid.outputs_preview',
        value: { stringValue: e.outputsPreview },
      });
    }
    return span;
  });
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: `opensquid/${t.packId}` } },
            { key: 'opensquid.skill', value: { stringValue: t.skill } },
            { key: 'opensquid.rule_id', value: { stringValue: t.ruleId } },
            { key: 'opensquid.event_kind', value: { stringValue: t.eventKind } },
            { key: 'opensquid.run_id', value: { stringValue: t.runId } },
          ],
        },
        scopeSpans: [{ scope: { name: 'opensquid.trace', version: '1' }, spans }],
      },
    ],
  };
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function msToUnixNanoString(ms: number): string {
  // 1ms = 1_000_000ns. BigInt to avoid Number precision loss above 2^53ns.
  return (BigInt(ms) * 1_000_000n).toString();
}
