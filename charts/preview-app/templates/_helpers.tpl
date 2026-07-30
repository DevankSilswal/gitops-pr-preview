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
