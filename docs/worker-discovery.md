# Worker Discovery Models

This document details the architectural choices and proposals for how **ORK** discovers and registers **Workers** within the MDK ecosystem.

## 1. Overview

This document exclusively covers how ORK becomes aware of a Worker and its capabilities ("Discovery / Registration"). 

MDK proposes two distinct discovery models.

---

## 2. Option A: Push Registration (Worker-Initiated)

In this model, the Worker initiates the first contact. It "announces" itself to ORK upon startup.

### Inspiration: Kubernetes (Kubelet)
In a Kubernetes cluster, the `kubelet` (the node agent) is responsible for self-registering with the API server. This allows the control plane to dynamically discover new capacity without needing a pre-defined list of every node's IP address.

### Flow
1. Worker boots and resolves ORK's RPC Key (via config or discovery).
2. Worker sends `identity.register` containing its ID, managed devices, and capability schema.
3. ORK validates the schema and sends `identity.register.ack`.
4. ORK adds the Worker to its active Registry.

### Pros
- **Simplicity:** Workers can be spun up dynamically (Docker, PM2) and appear in ORK without any central configuration change.
- **Client-Side Scaling:** Trivially supports horizontal scaling; more workers can be added to the pool at any time.
- **Zero-Conf ORK:** ORK doesn't need to know which workers *should* exist; it simply manages whoever *does* exist.

### Cons
- **Outbound Requirement:** Workers must be able to reach ORK on the network.
- **Discovery Overhead:** The worker needs a mechanism to find ORK (environment variables, or hardcoded RPC keys).

---

## 3. Option B: Pull Discovery (ORK-Initiated)

In this model, ORK initiates the first contact via pre-defined list of RPC Keys. ORK "probes" known RPC Keys to find active workers.

### Inspiration: Prometheus
- **Prometheus:** The Prometheus server is configured with a list of "targets" (exporters). It periodically scrapes these targets to pull metrics. If a target is down, Prometheus marks it as such.

### Flow
1. ORK is provided with a static list of expected Worker RPC Keys.
2. ORK sends `health.ping` to these endpoints.
3. If a Worker responds, ORK sends `identity.pull`.
4. The Worker responds with its registration payload.
5. ORK adds the Worker to its active Registry.

### Pros
- **Security / Firewalls:** Ideal for air-gapped or strictly firewalled environments where workers are "passive" and cannot initiate outbound connections.
- **Deterministic:** The administrator has absolute control over which workers ORK is allowed to talk to.
- **Centralized Config:** Discovery logic lives entirely in ORK.

### Cons
- **Configuration Burden:** Every new worker requires a config update in ORK.
- **Scale Limits:** At scale (hundreds of workers), the initial "probing" phase can become slow if many configured endpoints are offline and ORK keeps waiting till it times out.
