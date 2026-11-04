{{- define "blackbox.labels" -}}
app.kubernetes.io/name: blackbox
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end -}}

{{- define "blackbox.secretName" -}}
{{- .Values.existingSecret | default (printf "%s-secrets" .Release.Name) -}}
{{- end -}}

{{- define "blackbox.claimName" -}}
{{- .Values.persistence.existingClaim | default (printf "%s-data" .Release.Name) -}}
{{- end -}}

{{/* Pod spec shared by the API and worker Deployments. Call with (dict "root" $ "role" "api" "resources" …). */}}
{{- define "blackbox.podSpec" -}}
{{- $v := .root.Values -}}
serviceAccountName: blackbox
securityContext: { fsGroup: 10001 }
containers:
  - name: blackbox
    image: "{{ $v.image.repository }}:{{ $v.image.tag }}"
    imagePullPolicy: {{ $v.image.pullPolicy }}
    ports: [{ containerPort: 8080, name: http }]
    env:
      - { name: BLACKBOX_ROLE, value: {{ .role | quote }} }
      {{- if eq .role "worker" }}
      - { name: WORKER_CONCURRENCY, value: {{ $v.workers.concurrency | quote }} }
      {{- end }}
      - name: WORKER_ID
        valueFrom: { fieldRef: { fieldPath: metadata.name } }
    envFrom:
      - configMapRef: { name: {{ .root.Release.Name }}-config }
      - secretRef: { name: {{ include "blackbox.secretName" .root }}, optional: true }
    volumeMounts: [{ name: data, mountPath: /data }]
    readinessProbe: { httpGet: { path: /readyz, port: http } }
    livenessProbe: { httpGet: { path: /healthz, port: http }, periodSeconds: 20, failureThreshold: 6 }
    resources: {{- toYaml .resources | nindent 6 }}
volumes:
  - name: data
    persistentVolumeClaim: { claimName: {{ include "blackbox.claimName" .root }} }
{{- end -}}
