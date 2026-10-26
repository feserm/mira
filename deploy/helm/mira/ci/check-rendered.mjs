// Asserts security properties of the RENDERED chart, which kubeconform (schema only) cannot:
//   1. Pod Security `restricted` (Kubernetes 1.30 profile), field by field, for every pod kind
//      (web Deployment, worker Deployment, migration Job, retention CronJob);
//   2. with networkPolicy.enabled: a default deny that selects every pod kind, and per kind exactly the
//      ingress and egress it needs (docs/network-policy.md), e.g. the retention pods reach only Postgres and DNS.
// Reads the rendered manifests as one JSON array on stdin (CI: helm template | yq ea -o=json '[.]' -).
//   node check-rendered.mjs [--policies] [--mode cidr|cilium|https] [--pg-port 5432] [--issuer-port 443]
// No dependencies: it runs in the chart job, which installs no node modules.
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};
const expectPolicies = flag('policies');
const mode = option('mode', 'cidr');
const pgPort = Number(option('pg-port', '5432'));
const issuerPort = Number(option('issuer-port', '443'));

const docs = JSON.parse(readFileSync(0, 'utf8')).flat().filter(Boolean);
const failures = [];
const check = (ok, message) => {
	if (!ok) failures.push(message);
};

// ---- pod kinds -------------------------------------------------------------------------------------------
const podSpecOf = {
	Deployment: (d) => d.spec.template,
	Job: (d) => d.spec.template,
	CronJob: (d) => d.spec.jobTemplate.spec.template
};
const pods = docs
	.filter((d) => podSpecOf[d.kind])
	.map((d) => {
		const template = podSpecOf[d.kind](d);
		return {
			name: `${d.kind}/${d.metadata.name}`,
			component: template.metadata.labels['app.kubernetes.io/component'],
			labels: template.metadata.labels,
			spec: template.spec
		};
	});
check(pods.length > 0, 'no pod-carrying object was rendered');
const kinds = new Set(pods.map((p) => p.component));

// ---- Pod Security restricted ------------------------------------------------------------------------------
const ALLOWED_VOLUMES = new Set([
	'configMap',
	'csi',
	'downwardAPI',
	'emptyDir',
	'ephemeral',
	'persistentVolumeClaim',
	'projected',
	'secret'
]);
const SAFE_SYSCTLS = new Set([
	'kernel.shm_rmid_forced',
	'net.ipv4.ip_local_port_range',
	'net.ipv4.ip_unprivileged_port_start',
	'net.ipv4.tcp_syncookies',
	'net.ipv4.ping_group_range'
]);

for (const pod of pods) {
	const { spec, name } = pod;
	const podCtx = spec.securityContext ?? {};
	const containers = [...(spec.containers ?? []), ...(spec.initContainers ?? [])];
	check(containers.length > 0, `${name}: no containers`);

	// Baseline
	for (const f of ['hostNetwork', 'hostPID', 'hostIPC'])
		check(spec[f] !== true, `${name}: ${f} must not be true`);
	for (const v of spec.volumes ?? []) {
		const type = Object.keys(v).find((k) => k !== 'name');
		check(
			ALLOWED_VOLUMES.has(type),
			`${name}: volume ${v.name} has the type ${type}, not allowed by restricted`
		);
	}
	for (const s of podCtx.sysctls ?? [])
		check(SAFE_SYSCTLS.has(s.name), `${name}: sysctl ${s.name} is not on the safe list`);
	for (const f of ['seLinuxOptions', 'windowsOptions'])
		check(podCtx[f] === undefined, `${name}: securityContext.${f} is set`);
	check(
		podCtx.appArmorProfile === undefined || podCtx.appArmorProfile.type !== 'Unconfined',
		`${name}: AppArmor Unconfined`
	);

	// Restricted: the pod-level or the container-level value must hold for every container
	for (const c of containers) {
		const cc = c.securityContext ?? {};
		const where = `${name} container ${c.name}`;
		check(cc.privileged !== true, `${where}: privileged`);
		check(
			cc.allowPrivilegeEscalation === false,
			`${where}: allowPrivilegeEscalation must be false (unset counts as true)`
		);
		check(
			(cc.capabilities?.drop ?? []).includes('ALL'),
			`${where}: capabilities.drop must include ALL`
		);
		check(
			(cc.capabilities?.add ?? []).every((x) => x === 'NET_BIND_SERVICE'),
			`${where}: capabilities.add may only be NET_BIND_SERVICE`
		);
		check((cc.runAsNonRoot ?? podCtx.runAsNonRoot) === true, `${where}: runAsNonRoot must be true`);
		const uid = cc.runAsUser ?? podCtx.runAsUser;
		check(uid === undefined || uid !== 0, `${where}: runAsUser 0`);
		const seccomp = (cc.seccompProfile ?? podCtx.seccompProfile)?.type;
		check(
			['RuntimeDefault', 'Localhost'].includes(seccomp),
			`${where}: seccompProfile is ${seccomp}`
		);
		check(cc.procMount === undefined || cc.procMount === 'Default', `${where}: procMount`);
		for (const p of c.ports ?? []) check(!p.hostPort, `${where}: hostPort ${p.hostPort}`);
		// Not part of `restricted`, but this chart's own rules:
		check(cc.readOnlyRootFilesystem === true, `${where}: readOnlyRootFilesystem must be true`);
	}
	check(
		spec.automountServiceAccountToken === false,
		`${name}: automountServiceAccountToken must be false`
	);
}

// ---- NetworkPolicy ---------------------------------------------------------------------------------------
const policies = docs.filter((d) => d.kind === 'NetworkPolicy');
const cilium = docs.filter((d) => d.kind === 'CiliumNetworkPolicy');

if (!expectPolicies) {
	check(
		policies.length === 0,
		`networkPolicy.enabled=false must render no NetworkPolicy, got ${policies.length}`
	);
	check(cilium.length === 0, 'networkPolicy.enabled=false must render no CiliumNetworkPolicy');
} else {
	const selects = (policy, pod) =>
		Object.entries(policy.spec.podSelector.matchLabels ?? {}).every(
			([k, v]) => pod.labels[k] === v
		);
	const types = (p) => p.spec.policyTypes ?? [];

	const denies = policies.filter(
		(p) =>
			types(p).includes('Ingress') &&
			types(p).includes('Egress') &&
			!p.spec.ingress &&
			!p.spec.egress
	);
	check(denies.length === 1, `expected exactly one default-deny policy, got ${denies.length}`);

	const portsOf = (rules) => (rules ?? []).flatMap((r) => (r.ports ?? []).map((p) => p.port));
	const destinations = (rules) => (rules ?? []).flatMap((r) => r.to ?? []);

	for (const pod of pods) {
		const label = `${pod.component} (${pod.name})`;
		check(
			denies.every((d) => selects(d, pod)),
			`${label}: not selected by the default deny`
		);
		const own = policies.filter((p) => !denies.includes(p) && selects(p, pod));
		check(own.length === 1, `${label}: expected one allow policy, got ${own.length}`);
		const [policy] = own;
		if (!policy) continue;

		const ingressPorts = portsOf(policy.spec.ingress);
		const egressPorts = new Set(portsOf(policy.spec.egress));
		const egressTo = destinations(policy.spec.egress);

		// Every pod kind: DNS and the database, nothing broader
		check(egressPorts.has(53), `${label}: no DNS egress`);
		check(
			egressTo.some((t) => t.podSelector?.matchLabels?.['cnpg.io/cluster'] || t.ipBlock),
			`${label}: no database egress`
		);
		check(
			!egressTo.some((t) => t.ipBlock?.cidr === '0.0.0.0/0' && !t.ipBlock.except),
			`${label}: egress to 0.0.0.0/0 with no exceptions`
		);

		if (pod.component === 'web') {
			check(types(policy).includes('Ingress'), `${label}: ingress not restricted`);
			check(
				ingressPorts.length > 0 && ingressPorts.every((p) => p === 3000),
				`${label}: ingress must be on the container port only, got ${ingressPorts}`
			);
			const sources = (policy.spec.ingress ?? []).flatMap((r) => r.from ?? []);
			check(
				sources.length > 0 && sources.every((s) => s.namespaceSelector),
				`${label}: ingress sources must be namespaces, not "from everywhere"`
			);
			check(
				!egressTo.some((t) => t.ipBlock?.cidr === '198.51.100.0/24'),
				`${label}: web must not reach NCBI`
			);
		} else {
			check(
				!policy.spec.ingress && !types(policy).includes('Ingress'),
				`${label}: must accept no ingress`
			);
		}

		// What each kind may reach, by port. https mode adds 443 (and the issuer's port) to web and worker.
		const hostPorts = mode === 'cilium' ? [] : [issuerPort, 443];
		const allowed = {
			web: [53, pgPort, ...hostPorts],
			worker: [53, pgPort, ...hostPorts],
			migrate: [53, pgPort],
			retention: [53, pgPort]
		}[pod.component];
		check(allowed !== undefined, `${label}: unknown pod kind`);
		if (allowed) {
			const extra = [...egressPorts].filter(
				(p) => !allowed.includes(p) && !args.includes(`--extra-port=${p}`)
			);
			check(extra.length === 0, `${label}: egress ports outside ${allowed}: ${extra}`);
		}
		if (pod.component === 'migrate' || pod.component === 'retention')
			check(
				!egressTo.some(
					(t) => t.ipBlock?.cidr === '192.0.2.10/32' || t.ipBlock?.cidr === '198.51.100.0/24'
				),
				`${label}: must reach only Postgres and DNS`
			);
	}

	for (const kind of ['web', 'worker', 'migrate', 'retention'])
		if (kinds.has(kind))
			check(
				pods.some((p) => p.component === kind),
				`${kind}: no pod`
			);
	for (const p of policies)
		check(
			!p.spec.egress || p.spec.policyTypes?.includes('Egress'),
			`${p.metadata.name}: egress rules without policyType`
		);

	if (mode === 'cilium') {
		check(
			cilium.length === (kinds.has('worker') ? 2 : 1),
			`cilium mode: expected one CiliumNetworkPolicy per web and worker, got ${cilium.length}`
		);
		for (const c of cilium) {
			const fqdns = (c.spec.egress ?? []).flatMap((e) => e.toFQDNs ?? []).map((f) => f.matchName);
			check(
				fqdns.includes('git.example.org'),
				`${c.metadata.name}: no toFQDNs for the issuer host`
			);
			const isWorker = c.metadata.name.endsWith('-worker');
			check(
				fqdns.includes('eutils.ncbi.nlm.nih.gov') === isWorker,
				`${c.metadata.name}: NCBI only for the worker`
			);
		}
	} else {
		check(cilium.length === 0, `${mode} mode must render no CiliumNetworkPolicy`);
	}
}

if (failures.length > 0) {
	console.error(`check-rendered: ${failures.length} failure(s)`);
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(
	`check-rendered: ok (${pods.length} pod templates: ${[...kinds].join(', ')}; ${expectPolicies ? `network policies on, ${mode} mode` : 'network policies off'})`
);
