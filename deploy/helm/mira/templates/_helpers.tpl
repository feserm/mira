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
