{{- define "mira.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "mira.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "mira.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Labels without a component. Takes the root context. */}}
{{- define "mira.baseLabels" -}}
helm.sh/chart: {{ include "mira.chart" . }}
app.kubernetes.io/name: {{ include "mira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | trunc 63 | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/* Labels of the web objects. */}}
{{- define "mira.labels" -}}
{{ include "mira.baseLabels" . }}
app.kubernetes.io/component: web
{{- end }}

{{/* Labels of the worker objects. */}}
{{- define "mira.workerLabels" -}}
{{ include "mira.baseLabels" . }}
app.kubernetes.io/component: worker
{{- end }}

{{/* Immutable selector labels of the worker Deployment. Takes the root context. */}}
{{- define "mira.workerSelectorLabels" -}}
app.kubernetes.io/name: {{ include "mira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: worker
{{- end }}

{{/* Immutable selector labels of the web Deployment and Service. Takes the root context. */}}
{{- define "mira.selectorLabels" -}}
app.kubernetes.io/name: {{ include "mira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: web
{{- end }}

{{- define "mira.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "mira.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/* image.tag has no default: CI publishes only <commit sha> tags. */}}
{{- define "mira.image" -}}
{{- $tag := required "image.tag is required (the full commit SHA CI pushed; there is no latest tag)" .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{- printf "%s:%s@%s" .Values.image.repository $tag .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}
{{- end }}

{{/* The public origin: config.origin, else https://<ingress.host>. */}}
{{- define "mira.origin" -}}
{{- if .Values.config.origin -}}
{{- .Values.config.origin -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "https://%s" .Values.ingress.host -}}
{{- else -}}
{{- fail "set config.origin (https://host), or enable the ingress and set ingress.host" -}}
{{- end -}}
{{- end }}

{{- define "mira.terminationGracePeriodSeconds" -}}
{{- if .Values.terminationGracePeriodSeconds -}}
{{- .Values.terminationGracePeriodSeconds -}}
{{- else -}}
{{- add (int .Values.preStopSleepSeconds) (int .Values.config.shutdownTimeout) 10 -}}
{{- end -}}
{{- end }}

{{/* Required Secret reference, name and key. Takes a dict {ref, path}. */}}
{{- define "mira.secretKeyRef" -}}
secretKeyRef:
  name: {{ required (printf "%s.name is required (an existing Secret)" .path) .ref.name | quote }}
  key: {{ required (printf "%s.key is required" .path) .ref.key | quote }}
{{- end }}

{{/* Time a stopping worker gets: it waits worker.shutdownTimeoutSeconds for the running job, then
     hands it back and closes the pool (5 s bound), plus slack. */}}
{{- define "mira.workerTerminationGracePeriodSeconds" -}}
{{- if .Values.worker.terminationGracePeriodSeconds -}}
{{- .Values.worker.terminationGracePeriodSeconds -}}
{{- else -}}
{{- add (int .Values.worker.shutdownTimeoutSeconds) 15 -}}
{{- end -}}
{{- end }}

{{/* A private CA for the database, mounted from an existing Secret (config.db.caSecret). The three
     helpers are used by the web Deployment, the worker and the migration Job. Only `key` is projected,
     because CloudNativePG's <cluster>-ca Secret also holds the CA's private key (ca.key). */}}
{{- define "mira.dbCaEnv" -}}
{{- if .Values.config.db.caSecret.name -}}
- name: NODE_EXTRA_CA_CERTS
  value: /etc/mira/db-ca/{{ .Values.config.db.caSecret.key }}
{{- end -}}
{{- end }}

{{- define "mira.dbCaVolumeMount" -}}
{{- if .Values.config.db.caSecret.name -}}
- name: db-ca
  mountPath: /etc/mira/db-ca
  readOnly: true
{{- end -}}
{{- end }}

{{- define "mira.dbCaVolume" -}}
{{- if .Values.config.db.caSecret.name -}}
- name: db-ca
  secret:
    secretName: {{ .Values.config.db.caSecret.name | quote }}
    items:
      - key: {{ .Values.config.db.caSecret.key | quote }}
        path: {{ .Values.config.db.caSecret.key | quote }}
{{- end -}}
{{- end }}

{{/* Labels of the retention CronJob and its pods. */}}
{{- define "mira.retentionLabels" -}}
{{ include "mira.baseLabels" . }}
app.kubernetes.io/component: retention
{{- end }}

{{- define "mira.retentionSelectorLabels" -}}
app.kubernetes.io/name: {{ include "mira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: retention
{{- end }}

{{/* Labels of the migration Job's pods (the Job and the NetworkPolicy must agree). */}}
{{- define "mira.migrateSelectorLabels" -}}
app.kubernetes.io/name: {{ include "mira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: migrate
{{- end }}

{{/* Labels every pod of the release has, whatever its kind: what the default-deny policy selects. */}}
{{- define "mira.releaseSelectorLabels" -}}
app.kubernetes.io/name: {{ include "mira.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/* ---- NetworkPolicy rule fragments (S2.6). Each yields list items for an `egress:` list. ---- */}}

{{/* The port of config.oidc.issuerUrl: the one in the URL, else 443 (https) or 80 (http). */}}
{{- define "mira.issuerPort" -}}
{{- $u := urlParse .Values.config.oidc.issuerUrl -}}
{{- if contains ":" $u.host -}}
{{- last (splitList ":" $u.host) -}}
{{- else if eq $u.scheme "http" -}}
80
{{- else -}}
443
{{- end -}}
{{- end }}

{{- define "mira.np.dns" -}}
{{- $dns := .Values.networkPolicy.dns -}}
- to:
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ $dns.namespace | quote }}
      podSelector:
        matchLabels:
          {{- toYaml $dns.podSelector | nindent 10 }}
    {{- range $dns.cidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - protocol: UDP
      port: 53
    - protocol: TCP
      port: 53
{{- end }}

{{- define "mira.np.postgres" -}}
{{- $pg := .Values.networkPolicy.postgres -}}
- to:
    {{- if $pg.cidrs }}
    {{- range $pg.cidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
    {{- else }}
    - namespaceSelector:
        matchLabels:
          kubernetes.io/metadata.name: {{ default .Release.Namespace $pg.namespace | quote }}
      podSelector:
        matchLabels:
          {{- toYaml $pg.podSelector | nindent 10 }}
    {{- end }}
  ports:
    - protocol: TCP
      port: {{ $pg.port }}
{{- end }}

{{/* PLANTdataHUB (and, for the worker, NCBI). Takes {root, ncbi}. Nothing in cilium mode: the
     CiliumNetworkPolicy carries the host names there. */}}
{{- define "mira.np.hosts" -}}
{{- $np := .root.Values.networkPolicy -}}
{{- $port := int (include "mira.issuerPort" .root) -}}
{{- if eq $np.egress.mode "cidr" -}}
{{- if not $np.egress.plantdatahub.cidrs -}}
{{- fail "networkPolicy.egress.plantdatahub.cidrs is required in cidr mode: the addresses of the host in config.oidc.issuerUrl (a NetworkPolicy cannot name a host). Or set networkPolicy.egress.mode to cilium or https, see docs/network-policy.md" -}}
{{- end }}
- to:
    {{- range $np.egress.plantdatahub.cidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - protocol: TCP
      port: {{ $port }}
{{- if and .ncbi $np.egress.ncbi.enabled $np.egress.ncbi.cidrs }}
- to:
    {{- range $np.egress.ncbi.cidrs }}
    - ipBlock:
        cidr: {{ . | quote }}
    {{- end }}
  ports:
    - protocol: TCP
      port: 443
{{- end }}
{{- else if eq $np.egress.mode "https" }}
- to:
    - ipBlock:
        cidr: 0.0.0.0/0
        except:
          {{- toYaml $np.egress.httpsExcept | nindent 10 }}
  ports:
    - protocol: TCP
      port: 443
    {{- if ne $port 443 }}
    - protocol: TCP
      port: {{ $port }}
    {{- end }}
{{- end }}
{{- end }}
