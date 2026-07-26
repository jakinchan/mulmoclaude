# Draw action / custom-view / spinner icons with the font their names belong to

Issues: #2605 (visible breakage), #2606 (same cause, latent)

## The bug

Material Icons and Material Symbols both resolve an icon from the element's **text** via
a ligature. When the name isn't in the font, the ligature doesn't form and the browser
typesets the literal characters instead. The glyphs are invisible (the font has no
outlines for plain letters at those codepoints) but the **width stays**, and the name is
one unbreakable word — so it cannot shrink no matter how little room is left.

`progress_activity` in a `.material-icons` element measures **408px** instead of 24px.
In the record-detail header that pushes the title to width 0, wraps the button label,
and shoves the close button outside the popup. #2605 has the full measurement table.

#2606 is the same defect reached through data instead of code: action and custom-view
icon names come from `schema.json`, the docs tell the LLM to write **Material Symbols**
names there, and those two sites render with `.material-icons`.

## Verification done before writing any code

The issues' claims were re-measured in a real browser (Chromium, both stylesheets loaded
over HTTP, `document.fonts.ready` awaited, `getBoundingClientRect().width` at
`font-size: 24px` — a resolved ligature is exactly one em):

| name | Symbols | classic |
| --- | --- | --- |
| `progress_activity` | 24px | **408px** |
| `partly_cloudy_day` | 24px | 312px |
| `weather_snowy` | 24px | 312px |
| `rainy` | 24px | 120px |
| `smartphone` | 24px | 24px |
| `dashboard_customize` | 24px | 24px |
| `refresh` / `settings` / `delete` | 24px | 24px |

This reproduces #2605's 408px and #2606's three Symbols-only names exactly, so the
method and the diagnosis both hold.

**Do not trust either package's shipped name list.** #2605 already warned that
`material-icons`'s `_data/versions.json` disagrees with its font. The same is true on the
other side: `material-symbols/index.d.ts` omits `smartphone`, which the font resolves
fine. Both lists produce false results in *both* directions; only rendering settles it.
That is why the guard below measures nothing and asserts no name table.

## Change

Switch `.material-icons` → `material-symbols-outlined` at the 11 sites where the name
being rendered is a Symbols name. `material-symbols/outlined.css` is already imported
(`src/main.ts:24`) and `CollectionHeader.vue` already uses the class for the collection's
own icon, so this adds nothing to the bundle and follows existing precedent in the file.

Spinners — the name is `progress_activity`, hardcoded (#2605):

- `packages/plugins/collection-plugin/src/vue/components/CollectionRecordPanel.vue`
- `packages/plugins/collection-plugin/src/vue/components/CollectionHeader.vue`
- `packages/plugins/collection-plugin/src/vue/components/CollectionMutateParamsModal.vue`
- `src/plugins/wiki/history/HistoryDetail.vue`
- `src/plugins/wiki/history/HistoryTab.vue`
- `src/plugins/wiki/history/RestoreConfirm.vue`

Schema-driven icons — the name comes from `schema.json` (#2606):

- `CollectionRecordPanel.vue` (action icon)
- `CollectionHeader.vue` (collection-level action icon)
- `CollectionMutateParamsModal.vue` (action icon in the params form)
- `CollectionToolbar.vue` (custom-view icon, falls back to `smartphone` / `dashboard_customize`)
- `CollectionViewConfigModal.vue` (custom-view icon, falls back to `dashboard_customize`)

Both fallback names resolve in Symbols (measured above), so no default changes appearance.
#2606 measured the 31 icon names in real schemas and found none that resolve only in
classic, so no existing collection regresses either.

### Not doing

- **Migrating the whole app to Symbols.** `.material-icons` has 278 occurrences across
  100 files against 11 for Symbols — classic is the house convention. Moving it would
  mean verifying 278 names, which is a different piece of work from either issue.
- **`CollectionHeader.vue`'s `hourglass_empty` loading indicator.** #2605 notes it as a
  style inconsistency, not a defect: the name resolves in classic, so nothing is broken.
  Changing it would alter a working icon outside both issues' scope.
- **Clamping icon width defensively** (#2606 approach 2). Deferred deliberately — it
  hides the symptom of a bad name rather than surfacing it, and the guard below plus the
  docs already point the right way.

## Guard against recurrence

`test/components/test_icon_font_guard.ts` — a static scan in the same shape as
`test_translate_guard.ts` (#2563), parsing each SFC with `vue/compiler-sfc` rather than
grepping, so the class/text pairing is what's actually asserted.

The invariant: **no element carrying `material-icons` may have Symbols-only text.**
Seeded with `progress_activity`, the one name both issues trace back to.

Scope, stated plainly so nobody reads it as more than it is: this catches the exact
regression that produced #2605 and nothing else. A general guard would need to know every
name in each font, and the measurement above shows neither package's list can supply
that. The honest broad check is rendering width in a browser (#2605 approach 3), which
belongs in `yarn test:e2e` and is not part of this change.
