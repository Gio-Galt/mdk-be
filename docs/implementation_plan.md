# Alignment Plan: `mdk-ui` to HLD Architecture

Based on the inspection of the cloned `mdk-ui` repository, the current implementation follows a two-layer package model (`@tetherto/mdk-core` and `@tetherto/mdk-foundation`). This diverges significantly from the recently updated `hld-mdk-app.md` architecture, which enforces a strict separation between headless data logic, framework adapters, and the UI component library.

Here is the step-by-step action plan to bring `mdk-ui` into full alignment with the HLD.

## Open Questions
> [!IMPORTANT]
> **State Management:** Currently, `@tetherto/mdk-foundation` uses Redux Toolkit. The HLD specifies that the headless core should be framework-agnostic. Should we rewrite the state logic to use vanilla JavaScript subscriptions (or a lighter store like Zustand/Nano Stores) to ensure compatibility with Vue/Svelte adapters in the future?
>
> **Domain Components:** `@tetherto/mdk-foundation` currently holds domain-specific components (e.g., `DeviceExplorer`). Should these be moved into the new `@tetherto/mdk-ui-devkit-react` package, or left to be built exclusively by the consuming host applications (like MOS)?

## 1. Package Renaming & Restructuring

The packages in `mdk-ui` must be restructured to match the decoupled layers in the HLD.

### [MODIFY] `@tetherto/mdk-core` -> `@tetherto/mdk-ui-devkit-react`
The current `@tetherto/mdk-core` contains the generic Radix-based UI components. It should be renamed to `@tetherto/mdk-ui-devkit-react`.
- Update `package.json` name.
- Move any domain-specific UI components currently stuck in `foundation` over to this package (if we decide to keep them in the toolkit).

### [DELETE] `@tetherto/mdk-foundation`
This package currently mixes Headless State Logic, React Hooks, and Domain UI Components. It must be dissolved and its contents split into two new packages.

### [NEW] `@tetherto/mdk-ui-core`
This will be the new headless brain. 
- Extract the API client, constants, and state logic from the old `foundation`.
- Remove **all** React dependencies from this package's `package.json`.
- Implement the buffering, history ring buffer, and stale detection logic purely in JavaScript.

### [NEW] `@tetherto/mdk-react`
This will be the thin framework adapter.
- Extract the custom hooks (e.g., `usePermissions`, notification hooks, and the upcoming `useTelemetry` or `useCommand`) from the old `foundation`.
- These hooks will subscribe to the pure JS state emitted by `@tetherto/mdk-ui-core` and trigger React re-renders.

## 2. Implementing the 3-Tier CSS Customization Model

The current `@tetherto/mdk-core` uses SCSS and avoids Tailwind, which is excellent and aligns with the HLD. However, we need to enforce the new overriding model.

- **Level 1 (Global Tokens):** Ensure all SCSS files rely entirely on CSS Custom Properties (e.g., `var(--mdk-color-primary)`) rather than hardcoded SCSS variables (`$primary-color`), so host apps can override them at runtime.
- **Level 2 & 3 (`className` & `classNames`):** Refactor complex components to accept a `classNames` object prop (e.g., `classNames={{ root: '', header: '' }}`) to allow targeting specific DOM nodes within a component.
- **CSS `@layer`:** Wrap all SCSS outputs in `@layer mdk { ... }` to guarantee that the host application's styles will always win the specificity battle without needing `!important`.

## 3. Integration with MDK Backend Protocol

The current foundation relies on a generic "API barrel export". To align with the HLD, the frontend must interact with the MDK App Node.

- Update the API client in the new `@tetherto/mdk-ui-core` to handle real-time subscriptions (WebSockets or Server-Sent Events) for the rapid telemetry streams.
- Integrate the optimistic UI state machine (`pending`, `confirmed`, `failed`, `timeout`) for dispatching MDK Commands.

## Verification Plan
1. **Dependency Check:** Run `pnpm why react` inside the new `@tetherto/mdk-ui-core` package to strictly verify that 0 UI framework dependencies leaked into the headless core.
2. **CSS Specificity Test:** Create a demo app that overrides a `<DeviceTile />` background using a simple un-nested CSS class. Verify the override applies without `!important`, proving the `@layer mdk` works.
3. **Build:** Ensure `turbo build` completes successfully with the new package boundaries.
