# NetworkPolicies and Pod Security (S2.6)

Written for: whoever turns the policies on for staging and production (session L, the cluster operators).

Status: **rendered, validated and asserted in CI; never applied to a cluster.** No cluster was available. What ran
locally is marked "ran"; everything about how the real network plugin, the admission controller and
PLANTdataHUB behave is a decision backed by documentation, and says so. Chart values: `networkPolicy.*` in
[values.yaml](../deploy/helm/mira/values.yaml). Decision record: [adr/0004-edge-hardening.md](adr/0004-edge-hardening.md).

## 1. What the chart renders

With `networkPolicy.enabled=true` every pod of the release is denied all ingress and egress
(`<release>-mira-default-deny`, selecting the labels `app.kubernetes.io/name` and `/instance`, which every pod kind has),
and each kind gets one allow policy. Policies add up, so a pod may do what any policy selecting it allows.

| Pod kind (label `component`) | Ingress                                                                                         | Egress                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| `web`                        | TCP 3000 from the ingress controller's namespace and, with `secrets.metricsToken`, Prometheus's | DNS, Postgres, PLANTdataHUB       |
| `worker`                     | none                                                                                            | DNS, Postgres, PLANTdataHUB, NCBI |
| `migrate` (Helm hook Job)    | none                                                                                            | DNS, Postgres                     |
| `retention` (CronJob)        | none                                                                                            | DNS, Postgres                     |

`extraEgress` (web and worker) and `extraIngress` (web) take raw rules for anything else; the migration Job and the
retention CronJob get only Postgres and DNS whatever is set. Ran: `deploy/helm/mira/ci/check-rendered.mjs` parses
the rendered YAML and asserts exactly this (every pod kind selected by the deny, one allow policy each, the ports
each kind may reach, no ingress for the worker, the Job and the CronJob, retention and migrate never reaching the
PLANTdataHUB or NCBI addresses, no `0.0.0.0/0` without exceptions), for the three egress modes, and refuses
a chart that breaks it (CI runs it against deliberately wrong values, too).

**Hook ordering.** The migration Job is a `pre-install,pre-upgrade` hook. On the first install it runs before these
objects exist, so it is not restricted yet; on every upgrade they exist and it runs under `<release>-mira-migrate`. A
new egress rule for the Job therefore takes effect one upgrade late, which is why the Job's rules are only Postgres and
DNS and do not change.

## 2. Decisions

**On or off by default: off.** The chart cannot know the namespace of the ingress controller, whether the network plugin
enforces NetworkPolicy, or the addresses of PLANTdataHUB, and a policy with a wrong guess takes the site (ingress) or
login and imports (egress) down. Turning it on is a values change (below), and CI renders the on state. Production values
should set it `true`. The cost of the default is that an operator who does not read this page gets no network isolation.

**Egress to PLANTdataHUB and NCBI.** A NetworkPolicy cannot name a host. `docs/infrastructure.md` does not say which network
plugin the cluster uses, so the chart supports three ways and defaults to the one that works everywhere and guesses nothing:

| `networkPolicy.egress.mode` | What it does                                                                                                                                                                                                                  | Needs                            | Cost                                                                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cidr` (default)            | Egress to the addresses in `egress.plantdatahub.cidrs` (and `egress.ncbi.cidrs`, worker only), on the issuer's port (443 for https). **The chart refuses to render without the PLANTdataHUB addresses.**                      | the addresses, from the operator | You keep them current. NCBI's addresses change often: an empty list only drops the crop-name lookup (it is best effort already), the worker still imports. |
| `cilium`                    | A `CiliumNetworkPolicy` per web and worker with `toFQDNs` for the issuer host (and `eutils.ncbi.nlm.nih.gov` for the worker) plus the DNS rule Cilium needs to learn the addresses. Cilium unions it with the plain policies. | Cilium as the network plugin     | None, but the object is not validated by kubeconform (no schema in this repo); only its shape is asserted.                                                 |
| `https`                     | TCP 443 (and the issuer port) to any address outside `egress.httpsExcept` (the private ranges).                                                                                                                               | nothing                          | Allows every public HTTPS host: it stops lateral movement and the metadata endpoint, **not** exfiltration over 443. IPv6 is not covered.                   |

An egress proxy is not offered: the app's outbound `fetch` is not told to use one, so a proxy would need an application
change. `extraEgress` can allow a proxy's address for whoever adds that.

**What to use on staging.** `https` first, to see the traffic works at all (and to learn which hosts the app really talks
to, see section 6), then `cidr` or `cilium` with the real values.

**Namespaces.** `ingressController.namespace` (default `ingress-nginx`), `prometheus.namespace` (default `monitoring`), `dns.namespace`
(`kube-system`, pods `k8s-app=kube-dns`) and `postgres.namespace` (empty: the release namespace; pods `cnpg.io/cluster=mira-pg`)
are matched with the automatic label `kubernetes.io/metadata.name` (Kubernetes 1.22 and later). An ingress controller on the host
network is not a pod: use `extraIngress` with its node addresses. NodeLocal DNSCache is reached by address: `dns.cidrs`. An
external Postgres: `postgres.cidrs` (and `postgres.port`). The optional Pooler's pods have other labels: point
`postgres.podSelector` at them (labels from the operator docs, not checked).

Turn it on (values file):

```yaml
networkPolicy:
  enabled: true
  egress:
    mode: https # then cidr, with the real addresses
```

## 3. What a NetworkPolicy cannot do here

- **`/metrics` stays reachable from the ingress controller.** It is the same port as the app, and L4 policy has no paths.
  The scrape is allowed from the Prometheus namespace, but nothing stops the controller (so the internet) from asking
  for `/metrics`: the bearer token is the guard, as ADR 0003 decided. The policy is defence in depth for everything else, not a
  second lock on this path. Blocking the path is a rule for the ingress controller, not done here.
- **Kubelet probes** come from the node. The common plugins (Calico, Cilium) let the node reach its pods whatever the policy says; that is the
  plugin's behaviour, not checked here. If probes fail after turning the policy on, that is the first place to look.
- **Pods that are not this release's** (CloudNativePG, the operator, Prometheus) are untouched; see section 5 for the database.

## 4. Pod Security `restricted`

The pod and container security contexts come from `podSecurityContext` and `securityContext` in the values and are the
same for all four pod kinds. Checked field by field against the Kubernetes 1.30 `restricted` profile on the
**rendered** pods by `ci/check-rendered.mjs` (web Deployment, worker Deployment, migration Job, retention CronJob; it
fails the chart job if any value of the profile is broken, and runs again against deliberately broken values to prove it can fail):

| `restricted` requirement                                                                     | Where it is set                                          | Result |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------ |
| no `hostNetwork`, `hostPID`, `hostIPC`, `hostPath`, `hostPort`                               | not set anywhere                                         | met    |
| volume types limited (secret, configMap, ...)                                                | only the CA Secret (`secret`) is mounted                 | met    |
| `privileged` not true                                                                        | not set                                                  | met    |
| `allowPrivilegeEscalation: false`                                                            | `securityContext`, every container                       | met    |
| capabilities: drop `ALL`, add at most `NET_BIND_SERVICE`                                     | `securityContext.capabilities.drop: [ALL]`               | met    |
| `runAsNonRoot: true`, `runAsUser` not 0                                                      | `podSecurityContext` (user 1000)                         | met    |
| `seccompProfile`: `RuntimeDefault` or `Localhost`                                            | `podSecurityContext.seccompProfile.type: RuntimeDefault` | met    |
| no `procMount`, sysctls only from the safe list, no SELinux or AppArmor override             | not set                                                  | met    |
| (the chart's own rule) `readOnlyRootFilesystem: true`, `automountServiceAccountToken: false` | `securityContext`, pod spec                              | met    |

No gap was found, so no template changed for it. **Admission itself was not run**: that a real cluster accepts the pods in
a namespace labelled `enforce=restricted` is unverified. The chart does not create the namespace; label it
(also printed by `helm install` in the release notes):

```sh
kubectl label namespace mira \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted
```

Other pods in that namespace (the CloudNativePG instance pods from `deploy/postgres`, applied into the same namespace) must meet it as well,
or the label rejects them. Whether they do is not checked here; give the database its own namespace if they do not (then set `postgres.namespace`).

## 5. The Postgres side

`deploy/postgres/optional/networkpolicy.yaml` (not in the kustomization, validated by `deploy/postgres/validate.sh`): an
**ingress-only** policy for the database pods. Only the release's pods (`app.kubernetes.io/name=mira`), the cluster's own pods (replication,
the instance manager), the operator namespace (`cnpg-system`) and Prometheus (9187) may connect. Without it any pod in the cluster can try to
log in to `mira-pg-rw` (it still needs the password and TLS).

Decided against an **egress** policy for the database pods: they need the Kubernetes API (no stable address to name), the S3
endpoint for WAL archiving and base backups, and each other. A mistake would show as a stuck archiver, the failure that fills the WAL
volume ([infrastructure.md](infrastructure.md) section 3). The backup and replication paths are therefore unrestricted, and a rolling
update and a backup with the ingress policy on were **not run**.

## 6. What was not verified (needs a cluster, session L)

- That the network plugin **enforces** NetworkPolicy at all (a policy is accepted and silently ignored otherwise): from a pod of the release, a
  connection to a host the policy does not allow must fail, and one to Postgres must work.
- The egress paths actually work with the real addresses: login (OIDC discovery and token exchange), the ARC list, an import (Extract, Transform,
  Load), the access check, the refresh in the worker. **Extract follows redirects**: if PLANTdataHUB answers a package download with a redirect to
  object storage on another host, that host needs egress too (`https` mode shows it, `cidr` mode would fail the import). Not known.
- NCBI: the crop-name lookup with and without `egress.ncbi.cidrs`.
- The ingress controller's namespace and its pod labels, so that the site stays reachable; the scrape from the Prometheus namespace.
- Kubelet probes and rolling updates with the policies on (no failed requests during a rollout, the PDB still works).
- The migration Job under its policy on an upgrade, and the retention CronJob under its policy.
- `cilium` mode: that the `CiliumNetworkPolicy` is accepted, the FQDN rules resolve, and Cilium really unions it with the plain policies.
- Pod admission in a namespace labelled `restricted` (section 4), including the CloudNativePG pods.
- The optional Postgres policy: the operator namespace name, that no other port is needed, replication and a failover with it applied, a base backup and
  WAL archiving still passing.
