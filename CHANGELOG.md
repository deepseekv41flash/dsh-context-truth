# Changelog

## 0.1.0

First release.

- **Measured occupancy line**: a dynamic runtime-context contribution rendered from
  `tokenMeter.measure(session).totalTokens` (falling back to the `contextPressure`
  projection), with the auto-compaction point derived exactly the way
  `dsh-compaction-basic` derives it. Four bands (ample / moderate / tight / critical)
  with hysteresis, quantized display steps so an unchanged reading never re-injects,
  and a headroom figure that always rounds down — it never promises more room than the
  session has.
- **Compaction directive rules**: the summarizer's trailing directive is extended
  through the public `llm/stream` waterfall (tail-only; the cached prefix is byte-identical)
  so a summary stops carrying the assistant's own guesses about its remaining budget
  forward as established background.
- Zero dependencies, no build step, no tools, no client bundle.
- Bilingual docs: `README.md` (简体中文) and `README-en.md` (English), switched by the
  language line under the title.
- Mounting twice in one scope (bundle assembly plus a runtime injection of the same
  package) leaves the second instance inert instead of failing.
- 21 unit tests: banding, hysteresis, quantization, conservative headroom, degradation on a
  broken meter, directive patching, idempotence, duplicate mounts, and the disabled/interceptor paths.
