/**
 * Browser half of dsh-context-truth: the fold-mode panel on the plugin's page.
 *
 * Why this file exists: DSH does not auto-render a plugin's `Config` as a settings
 * form. A plugin row gets a configure panel only when a client module registers a
 * `plugins.bundle.config` (bundle level) or `plugins.row.config` slot key — see
 * `dsh-client-ui-plugin-manager`'s config ledger. `dsh-auto-retry` and the official
 * cot-translation bundle both ship a `./client` module for exactly that reason, so
 * this plugin needs one too, otherwise its 29-field schema is unreachable from the UI.
 *
 * The panel talks to the settings Remote directly:
 *   settings.describe() -> { ok, value: { namespaces: [{ ns, revision, value, ... }] } }
 *   settings.mutate(ns, ops, expectedRevision)
 * Both are the same calls the built-in settings page makes.
 */
window.__ModuleLoader__.load({
  id: 'dsh-context-truth',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')

    const NS = 'context-truth'
    const LABEL = {
      title: '折叠模式 / Fold mode',
      hint:
        '默认 idle：到点后在模型自己的轮次边界折叠。' +
        ' handoff 为实验特性：先写交接档、折叠后自动回读一次。' +
        ' 切换立即生效，不需要重启；但切换本身不会触发折叠。',
      off: 'off — 只报告，不折叠',
      idle: 'idle — 自动闲时压缩（默认）',
      handoff: 'handoff — 交接式折叠（实验性）',
      saving: '保存中…',
      saved: '已保存',
    }

    const messageOf = (error) =>
      error === null || error === undefined ? 'unknown error' : error.message ?? String(error)

    /** One row: a mode select bound to the `foldMode` field of the live config. */
    function FoldModePanel(props) {
      const [state, setState] = React.useState({ status: 'loading', revision: 0, mode: undefined, note: null })

      const load = React.useCallback(async () => {
        try {
          const response = await props.settings.describe()
          if (!response.ok) throw new Error(`settings.describe failed: ${messageOf(response.error)}`)
          const view = (response.value.namespaces || []).find((row) => row.ns === NS)
          if (view === undefined) throw new Error(`settings namespace "${NS}" is not served`)
          setState({
            status: 'ready',
            revision: view.revision,
            mode: view.value === undefined ? undefined : view.value.foldMode,
            note: null,
          })
        } catch (error) {
          setState((previous) => ({ ...previous, status: 'error', note: messageOf(error) }))
        }
      }, [props.settings])

      React.useEffect(() => {
        load()
      }, [load])

      const choose = React.useCallback(
        async (event) => {
          const value = event.target.value
          setState((previous) => ({ ...previous, status: 'saving', note: LABEL.saving }))
          try {
            const ops = [{ op: 'set', path: ['foldMode'], value }]
            const response = await props.settings.mutate(NS, ops, state.revision)
            if (!response.ok) throw new Error(`settings.mutate failed: ${messageOf(response.error)}`)
            // On success the Remote returns the fresh namespace view, so no second
            // describe() is needed (the built-in form controller relies on the same).
            const view = response.value
            setState({
              status: 'ready',
              revision: view === undefined ? state.revision : view.revision,
              mode: view === undefined || view.value === undefined ? undefined : view.value.foldMode,
              note: LABEL.saved,
            })
          } catch (error) {
            setState((previous) => ({ ...previous, status: 'error', note: messageOf(error) }))
          }
        },
        [props.settings, state.revision],
      )

      const current = state.mode === undefined ? 'idle' : state.mode
      const busy = state.status === 'saving'
      const note = state.note
      return React.createElement(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '4px 0' } },
        React.createElement(
          'label',
          { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' } },
          React.createElement('span', { style: { fontWeight: 600 } }, LABEL.title),
          React.createElement(
            'select',
            {
              value: current,
              disabled: busy,
              onChange: choose,
              'aria-label': LABEL.title,
              style: { minWidth: '220px', padding: '2px 4px' },
            },
            React.createElement('option', { value: 'off' }, LABEL.off),
            React.createElement('option', { value: 'idle' }, LABEL.idle),
            React.createElement('option', { value: 'handoff' }, LABEL.handoff),
          ),
        ),
        React.createElement('span', { style: { fontSize: '12px', opacity: 0.65 } }, LABEL.hint),
        note === null
          ? null
          : React.createElement(
              'span',
              {
                role: state.status === 'error' ? 'alert' : 'status',
                style: { fontSize: '12px', color: state.status === 'error' ? '#e5534b' : 'inherit', opacity: state.status === 'error' ? 1 : 0.75 },
              },
              note,
            ),
      )
    }

    /** Client services: slots to register the panel, remote.settings to read/write it. */
    const inject = ['slots', 'remote', 'remote.settings']

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                id: 'context-truth-fold',
                // The ledger matches this key against the bundle package name.
                key: 'dsh-context-truth',
                order: 10,
                inject: () => ({ settings: ctx.remote.settings }),
              },
              FoldModePanel,
            ),
          ),
        'context-truth: fold mode panel',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
