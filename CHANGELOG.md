# Changelog

## 0.1.3

Four changes, all from capturing a real compaction request in a live session (and from the host
log line that capture explained):

- **A request that merely quotes the directive is no longer mistaken for a compaction call.**
  Detection trusted a substring match on the trailing message, so an ordinary turn whose last tool
  result dumped the engine source or a session log was treated as the summarizer call — one real
  tool result contained 10 marker hits. A caller-set `purpose` is now authoritative, and the
  tagless fallback requires the trailing message to *begin* with the directive.
- **A look-alike can no longer spend the one-shot failure warning.** In the wild it did: the
  warning fired for an ordinary turn, which would have left a later *real* failure completely
  silent. Only a call tagged `purpose: 'compaction'` may consume the warning now.
- **A reading below one display step says so instead of rendering `0`.** After a compaction the
  meter reads 30–50K against a 50K step, so the line printed `0 / 1.00M tokens used (0%)` while
  the same line reported ~600K of headroom — an empty window and a nearly full one at once. It now
  prints `under 50K / 1.00M tokens used (under 5%)` (`不足 50K`), and a headroom inside its own
  step prints `Under 2K` rather than `less than 1K`.
- **Rule 1 forbids quoting, not just asserting.** It now bans recording such claims quoted,
  paraphrased, or listed as an example, and tells the summarizer to drop the wording when an
  earlier checkpoint already carries it. The rule embeds no quotable example phrases of its own.
- 28 unit tests (was 21), including the real look-alike request shape and the sub-step rendering.

## 0.1.2

- Maintenance release: identical code and docs to 0.1.0. Published directly because npm staged
  0.1.1 and the registry would not accept an approval for that stage record.

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
