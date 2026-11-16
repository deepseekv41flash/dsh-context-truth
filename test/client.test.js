/**
 * Structural test for the browser half. It cannot render React here, but it proves
 * the two things that break silently in the browser:
 *   1) the module wrapper loads under the client module loader's id;
 *   2) `apply` registers a `plugins.bundle.config` slot whose key is the bundle
 *      package name — the key the plugin manager's config ledger looks up.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

const loaded = []
globalThis.window = { __ModuleLoader__: { load: (definition) => loaded.push(definition) } }
await import('../lib/client.js')

const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: (initial) => [initial, () => {}],
  useCallback: (fn) => fn,
  useEffect: () => {},
}

test('the client module loads under the package id and registers the fold-mode panel', () => {
  assert.equal(loaded.length, 1, 'the module wrapper must call the loader exactly once')
  const { id, factory } = loaded[0]
  assert.equal(id, 'dsh-context-truth')

  const module = factory((name) => {
    assert.equal(name, 'react', 'the client module must only require react')
    return fakeReact
  })
  assert.equal(typeof module.apply, 'function')
  assert.deepEqual(module.inject, ['slots', 'remote', 'remote.settings'])

  const calls = []
  const settings = { describe: async () => ({ ok: true, value: { namespaces: [] } }), mutate: async () => ({ ok: true }) }
  const ctx = {
    remote: { settings },
    effect: (run) => run(),
    slots: {
      inject: (name, register) => {
        calls.push(name)
        return register()
      },
      register: (options, component) => {
        calls.push({ options, component })
        return () => {}
      },
    },
  }
  module.apply(ctx)

  assert.equal(calls[0], 'plugins.bundle.config', 'the panel must attach to the bundle config slot')
  const registration = calls[1]
  assert.equal(registration.options.name, 'plugins.bundle.config')
  assert.equal(registration.options.key, 'dsh-context-truth', 'the ledger key is the bundle package name')
  assert.equal(typeof registration.options.inject, 'function')
  assert.equal(registration.options.inject().settings, settings)
  assert.equal(typeof registration.component, 'function')
})
