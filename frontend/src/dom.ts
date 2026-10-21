import { createEffect } from 'solid-js';

// Keeps a <select>'s value in sync once its options exist. `options` must read whatever the
// option list is built from, so the value is applied again after the list changes.
export function selectValue(value: () => string, options: () => unknown) {
  let el: HTMLSelectElement | undefined;
  createEffect(() => [value(), options()] as const, ([v]) => { if (el) el.value = v; });
  return (node: HTMLSelectElement) => { el = node; };
}
