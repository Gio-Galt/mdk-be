# MDK Library Ecosystem

The MDK platform is decomposed into several modular libraries across the backend (Orchestration/App Node) and frontend (UI/Dashboard). This modularity ensures developers only import the exact layer of abstraction they need.

| S.No. | Package | Domain | Language | Description | Status | Pending Tasks |
|---|---|---|---|---|---|---|
| 1 | **`@tetherto/mdk-ork`** | Backend | TypeScript / Node.js | Core Orchestration Kernel. Manages worker registries, routes commands, and collects telemetry. Zero business logic. | 🏗️ **Design Ready** (Needs Refactor) | Scaffold Kernel, build Worker Registry, Command Dispatcher, and Telemetry state machines. |
| 2 | **`@tetherto/mdk-client`** | Backend / Comm | TypeScript / Node.js (Python, Go planned) | Universal transport SDK (IPC/HRPC) used to communicate securely with the ORK Kernel. | 🚀 **Design Ready** (Needs Development) | Implement `Hyperswarm` HRPC transport layer. |
| 3 | **`@tetherto/mdk-app-node`** | Backend | TypeScript / Node.js | Gateway middleware (Fastify/Express) handling JWT auth, RBAC, REST/WS routes, and MCP Server for AI agents. | 🏗️ **Design Ready** (Needs Refactor) | Scaffold Fastify/Express middleware, implement JWT RBAC logic, and build MCP endpoints. |
| 4 | **`@tetherto/mdk-worker-base`**| Backend / Edge | JavaScript / Node.js | Base SDK for external hardware integrations. Extended to build device-specific translators that independently manage hardware execution, handle local telemetry aggregation, and expose self-describing capabilities to ORK. | 🏗️ **Design Ready** (Needs Refactor) | Refactor by consolidating current templates along with usage of `@tetherto/mdk-client` |
| 5 | **`@tetherto/mdk-ui-core`** | Frontend | JavaScript (Vanilla) | Headless state brain. Buffers telemetry streams and manages optimistic UI. Zero React dependencies. | 🏗️ **Design Ready** (Needs Refactor) | Migrate state logic and API client from the legacy `foundation` package. |
| 6 | **`@tetherto/mdk-react`** | Frontend | TypeScript / React | Thin framework adapters. Provides hooks (e.g., `useTelemetry`) to bridge headless state into React components. | 🏗️ **Design Ready** (Needs Refactor) | Migrate hooks from the legacy `foundation` package. |
| 7 | **`@tetherto/mdk-ui-devkit-react`** | Frontend | TypeScript / React | Production-tested UI component library (Radix UI). Uses 3-tier CSS customization with no host Tailwind dependency. | ✅ **Ready** | Refactor components to use `classNames` and wrap default SCSS output in `@layer mdk`. |
