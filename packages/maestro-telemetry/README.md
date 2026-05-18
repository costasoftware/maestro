# maestro-telemetry (reserved)

This name is reserved for a future typed control-plane client (`maestro-plane`) on top of [`@costasoftware/maestro-core`](https://www.npmjs.com/package/@costasoftware/maestro-core). It will ship:

- `HttpTelemetrySink` — batched HTTP POSTs to the Maestro control plane
- Retry + circuit-breaker
- Replaces the `NoopTelemetrySink` default that ships in `@costasoftware/maestro-core`

See the [Maestro repo](https://github.com/costasoftware/maestro) for design status. Don't depend on this `0.0.0` placeholder — it has no runtime code.

## License

Apache-2.0
