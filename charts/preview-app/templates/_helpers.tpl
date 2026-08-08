{{- define "preview-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-app.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "preview-app.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-app.labels" -}}
app.kubernetes.io/name: {{ include "preview-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
preview.environment: {{ .Values.environment | quote }}
preview.pr-number: {{ .Values.prNumber | quote }}
{{- end -}}

{{- define "preview-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "preview-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "preview-app.databaseFullname" -}}
{{- printf "%s-db" (include "preview-app.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "preview-app.databaseSelectorLabels" -}}
app.kubernetes.io/name: {{ include "preview-app.name" . }}-db
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: database
{{- end -}}

{{/*
A per-environment secret, derived rather than generated.

Generating one with randAlphaNum would produce a different value on every
render, so ArgoCD would see the manifest change on every sync and selfHeal
would fight itself forever. Deriving it from a cluster-wide salt plus the
environment's own identity makes it stable across renders, distinct between
environments, and — the part that matters for the preview password — separately
computable by CI, which has the same salt but no access to the cluster and so
could never read a value the chart had invented.

The salt is the only real input. It is generated once at bootstrap, lives in
argocd-secret and in a repository secret, and never appears in git.
*/}}
{{- define "preview-app.derivedSecret" -}}
{{- if not .salt -}}
{{- fail "a salt is required to derive per-environment secrets; bootstrap-cluster.sh sets PREVIEW_SECRET_SALT" -}}
{{- end -}}
{{- printf "%s|%s|%s|%s" .salt .environment (toString .prNumber) .purpose | sha256sum | trunc 20 -}}
{{- end -}}

{{- define "preview-app.authPassword" -}}
{{- include "preview-app.derivedSecret" (dict "salt" .Values.secretSalt "environment" .Values.environment "prNumber" .Values.prNumber "purpose" "basic-auth") -}}
{{- end -}}

{{- define "preview-app.databasePassword" -}}
{{- include "preview-app.derivedSecret" (dict "salt" .Values.secretSalt "environment" .Values.environment "prNumber" .Values.prNumber "purpose" "database") -}}
{{- end -}}
