import * as k8s from '@kubernetes/client-node';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';
import type { RepoInfo } from './git.js';
import { gitProvider } from './git.js';

const MANAGED_BY = 'asterius-blackbox';
const FIELD_MANAGER = 'asterius-blackbox';

export type Addon = 'postgres' | 'redis';

export interface DeployRequest {
  appId: string;
  appSlug: string;
  repo: RepoInfo;
  /** Agent working copy (used by the docker build mode). */
  workspace: string;
  envSlug: string; // short env id chosen by the agent, e.g. "feat-login"
  branch: string;
  commitSha: string;
  port: number;
  healthPath: string;
  dockerfile: string;
  contextSubPath?: string;
  env: Record<string, string>;
  addons: Addon[];
  onStatus: (s: { stage: 'building' | 'deploying' | 'ready' | 'failed'; message: string }) => void;
}

export interface DeployResult {
  name: string;
  namespace: string;
  url: string;
  image: string;
  expiresAt: string;
}

const dns = (s: string, max = 63) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, max)
    .replace(/-$/, '');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isNotFound(err: unknown) {
  return (err as { code?: number })?.code === 404;
}

export class KubernetesEnvironments {
  private kc = new k8s.KubeConfig();
  private core: k8s.CoreV1Api;
  private batch: k8s.BatchV1Api;
  private apps: k8s.AppsV1Api;
  private objects: k8s.KubernetesObjectApi;

  constructor() {
    if (config.KUBECONFIG_PATH) this.kc.loadFromFile(config.KUBECONFIG_PATH);
    else this.kc.loadFromDefault();
    if (config.K8S_CONTEXT) this.kc.setCurrentContext(config.K8S_CONTEXT);
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.batch = this.kc.makeApiClient(k8s.BatchV1Api);
    this.apps = this.kc.makeApiClient(k8s.AppsV1Api);
    this.objects = k8s.KubernetesObjectApi.makeApiClient(this.kc);
  }

  names(appSlug: string, envSlug: string) {
    const name = dns(`${appSlug}-${envSlug}`, 50);
    const namespace = dns(`${config.K8S_NAMESPACE_PREFIX}-${name}`);
    const host = `${name}.${config.K8S_BASE_DOMAIN}`;
    const scheme = config.K8S_INGRESS_TLS_SECRET || config.K8S_CLUSTER_ISSUER ? 'https' : 'http';
    const port = config.K8S_PUBLIC_PORT ? `:${config.K8S_PUBLIC_PORT}` : '';
    return { name, namespace, host, url: `${scheme}://${host}${port}` };
  }

  /** Server-side apply, retrying transient failures (admission webhooks starting up, API throttling). */
  private async apply(obj: k8s.KubernetesObject) {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.objects.patch(obj, undefined, undefined, FIELD_MANAGER, true, k8s.PatchStrategy.ServerSideApply);
        return;
      } catch (err) {
        const code = (err as { code?: number }).code ?? 0;
        const body = String((err as { body?: unknown }).body ?? '');
        const transient = code === 429 || code >= 500 || /failed calling webhook/.test(body);
        if (!transient || attempt >= 6) throw err;
        await sleep(attempt * 2000);
      }
    }
  }

  // ---------------------------------------------------------------- deploy
  async deploy(req: DeployRequest): Promise<DeployResult> {
    const { name, namespace, host, url } = this.names(req.appSlug, req.envSlug);
    const expiresAt = new Date(Date.now() + config.K8S_ENV_TTL_HOURS * 3600_000).toISOString();
    const labels = { 'app.kubernetes.io/managed-by': MANAGED_BY, 'blackbox/app-id': req.appId, 'blackbox/env': name };

    // 1. Build the image in-cluster from the pushed branch.
    const tag = `${dns(req.branch, 40)}-${req.commitSha.slice(0, 10)}`;
    const image = `${config.K8S_IMAGE_REGISTRY}/${req.appSlug}:${tag}`;
    req.onStatus({ stage: 'building', message: `Building image ${image} from ${req.branch}@${req.commitSha.slice(0, 8)}` });
    if (config.K8S_BUILD_MODE === 'docker') await this.dockerBuild(req, image);
    else await this.build(req, image, labels);

    // 2. Namespace + guard-rails.
    req.onStatus({ stage: 'deploying', message: `Deploying to namespace ${namespace}` });
    await this.ensureNamespace(namespace, labels, expiresAt);

    // 3. Addons (ephemeral, in-namespace).
    const env: Record<string, string> = { ...req.env, PORT: String(req.port) };
    for (const addon of req.addons) Object.assign(env, await this.deployAddon(namespace, addon, labels));

    // 4. Application.
    await this.apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: 'app-env', namespace, labels },
      stringData: env,
    } as k8s.V1Secret);

    const podLabels = { ...labels, 'app.kubernetes.io/name': 'app' };
    await this.apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: 'app', namespace, labels: podLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': 'app' } },
        template: {
          metadata: { labels: podLabels, annotations: { 'blackbox/commit': req.commitSha } },
          spec: {
            ...(config.K8S_REGISTRY_PULL_SECRET ? { imagePullSecrets: [{ name: config.K8S_REGISTRY_PULL_SECRET }] } : {}),
            automountServiceAccountToken: false,
            containers: [
              {
                name: 'app',
                image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: req.port, name: 'http' }],
                envFrom: [{ secretRef: { name: 'app-env' } }],
                readinessProbe: { httpGet: { path: req.healthPath, port: 'http' }, initialDelaySeconds: 3, periodSeconds: 5, failureThreshold: 24 },
                resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '1', memory: '1Gi' } },
                securityContext: { allowPrivilegeEscalation: false },
              },
            ],
          },
        },
      },
    } as k8s.V1Deployment);
    await this.apply({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: 'app', namespace, labels },
      spec: { selector: { 'app.kubernetes.io/name': 'app' }, ports: [{ port: 80, targetPort: 'http', name: 'http' }] },
    } as k8s.V1Service);

    const tls = config.K8S_INGRESS_TLS_SECRET || config.K8S_CLUSTER_ISSUER;
    await this.apply({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: 'app',
        namespace,
        labels,
        annotations: config.K8S_CLUSTER_ISSUER ? { 'cert-manager.io/cluster-issuer': config.K8S_CLUSTER_ISSUER } : {},
      },
      spec: {
        ingressClassName: config.K8S_INGRESS_CLASS,
        ...(tls ? { tls: [{ hosts: [host], secretName: config.K8S_INGRESS_TLS_SECRET || `${name}-tls` }] } : {}),
        rules: [{ host, http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'app', port: { name: 'http' } } } }] } }],
      },
    } as k8s.V1Ingress);

    // 5. Wait for rollout.
    await this.waitForRollout(namespace, 'app', req.commitSha);
    req.onStatus({ stage: 'ready', message: `Environment ready at ${url}` });
    return { name, namespace, url, image, expiresAt };
  }

  private async ensureNamespace(namespace: string, labels: Record<string, string>, expiresAt: string) {
    await this.apply({
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: { name: namespace, labels, annotations: { 'blackbox/expires-at': expiresAt } },
    } as k8s.V1Namespace);
    await this.apply({
      apiVersion: 'v1',
      kind: 'ResourceQuota',
      metadata: { name: 'blackbox-quota', namespace },
      spec: { hard: { 'requests.cpu': '2', 'requests.memory': '4Gi', 'limits.cpu': '4', 'limits.memory': '8Gi', pods: '10', 'persistentvolumeclaims': '2' } },
    } as k8s.V1ResourceQuota);
    await this.apply({
      apiVersion: 'v1',
      kind: 'LimitRange',
      metadata: { name: 'blackbox-limits', namespace },
      spec: { limits: [{ type: 'Container', _default: { cpu: '500m', memory: '512Mi' }, defaultRequest: { cpu: '50m', memory: '64Mi' } }] },
    } as k8s.V1LimitRange);
    // Only the ingress controller and pods of the same namespace may reach the environment.
    await this.apply({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'NetworkPolicy',
      metadata: { name: 'blackbox-isolation', namespace },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
          // NB: the typed serializer maps `_from` → `from` (a plain `from` key is silently dropped).
          { _from: [{ podSelector: {} }] },
          { _from: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': config.K8S_INGRESS_NAMESPACE } } }] },
        ],
      },
    } as k8s.V1NetworkPolicy);
  }

  private async deployAddon(namespace: string, addon: Addon, labels: Record<string, string>): Promise<Record<string, string>> {
    const password = await this.stablePassword(namespace, addon);
    const spec =
      addon === 'postgres'
        ? { image: 'postgres:17-alpine', port: 5432, env: { POSTGRES_PASSWORD: password, POSTGRES_USER: 'app', POSTGRES_DB: 'app' } }
        : { image: 'redis:7-alpine', port: 6379, env: {}, args: ['--requirepass', password] };
    const podLabels = { ...labels, 'app.kubernetes.io/name': addon };
    await this.apply({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: { name: addon, namespace, labels: podLabels },
      spec: {
        replicas: 1,
        selector: { matchLabels: { 'app.kubernetes.io/name': addon } },
        template: {
          metadata: { labels: podLabels },
          spec: {
            automountServiceAccountToken: false,
            containers: [
              {
                name: addon,
                image: spec.image,
                args: 'args' in spec ? spec.args : undefined,
                ports: [{ containerPort: spec.port }],
                env: Object.entries(spec.env).map(([name, value]) => ({ name, value })),
                resources: { requests: { cpu: '50m', memory: '128Mi' }, limits: { cpu: '500m', memory: '512Mi' } },
              },
            ],
          },
        },
      },
    } as k8s.V1Deployment);
    await this.apply({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: addon, namespace, labels },
      spec: { selector: { 'app.kubernetes.io/name': addon }, ports: [{ port: spec.port, targetPort: spec.port }] },
    } as k8s.V1Service);
    return addon === 'postgres'
      ? { DATABASE_URL: `postgresql://app:${password}@postgres:5432/app`, PGHOST: 'postgres', PGUSER: 'app', PGPASSWORD: password, PGDATABASE: 'app' }
      : { REDIS_URL: `redis://:${password}@redis:6379` };
  }

  /** Keep addon passwords stable across redeploys (stored in a Secret). */
  private async stablePassword(namespace: string, addon: string) {
    const secretName = `${addon}-credentials`;
    try {
      const s = await this.core.readNamespacedSecret({ name: secretName, namespace });
      const v = s.data?.password;
      if (v) return Buffer.from(v, 'base64').toString();
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const password = randomBytes(18).toString('base64url');
    await this.apply({ apiVersion: 'v1', kind: 'Secret', metadata: { name: secretName, namespace }, stringData: { password } } as k8s.V1Secret);
    return password;
  }

  // ---------------------------------------------------------------- build
  private async build(req: DeployRequest, image: string, labels: Record<string, string>) {
    const ns = config.K8S_BUILD_NAMESPACE;
    const jobName = dns(`build-${req.appSlug}-${req.commitSha.slice(0, 8)}-${Date.now().toString(36)}`);
    const ctx = gitProvider().buildContext(req.repo, req.branch);

    await this.apply({
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name: jobName, namespace: ns, labels },
      stringData: { GIT_USERNAME: ctx.username, GIT_PASSWORD: ctx.password },
    } as k8s.V1Secret);

    const args = [
      `--context=${ctx.context}#${req.commitSha}`,
      `--dockerfile=${req.dockerfile}`,
      `--destination=${image}`,
      '--cache=true',
      '--snapshot-mode=redo',
      '--use-new-run',
    ];
    if (req.contextSubPath) args.push(`--context-sub-path=${req.contextSubPath}`);
    if (config.K8S_REGISTRY_INSECURE) args.push('--insecure', '--skip-tls-verify');

    await this.batch.createNamespacedJob({
      namespace: ns,
      body: {
        metadata: { name: jobName, labels },
        spec: {
          backoffLimit: 0,
          ttlSecondsAfterFinished: 3600,
          activeDeadlineSeconds: 1800,
          template: {
            metadata: { labels },
            spec: {
              restartPolicy: 'Never',
              automountServiceAccountToken: false,
              containers: [
                {
                  name: 'kaniko',
                  image: config.K8S_KANIKO_IMAGE,
                  args,
                  envFrom: [{ secretRef: { name: jobName } }],
                  volumeMounts: [{ name: 'docker-config', mountPath: '/kaniko/.docker' }],
                  resources: { requests: { cpu: '500m', memory: '1Gi' }, limits: { cpu: '2', memory: '4Gi' } },
                },
              ],
              volumes: [
                {
                  name: 'docker-config',
                  secret: { secretName: config.K8S_REGISTRY_PUSH_SECRET, items: [{ key: '.dockerconfigjson', path: 'config.json' }] },
                },
              ],
            },
          },
        },
      },
    });

    const deadline = Date.now() + 30 * 60_000;
    try {
      while (Date.now() < deadline) {
        await sleep(5000);
        const job = await this.batch.readNamespacedJob({ name: jobName, namespace: ns });
        if (job.status?.succeeded) return;
        if (job.status?.failed) {
          const logs = await this.podLogs(ns, `job-name=${jobName}`, 120);
          throw new Error(`Image build failed.\n--- kaniko logs (tail) ---\n${logs}`);
        }
      }
      throw new Error('Image build timed out after 30 minutes');
    } finally {
      await this.core.deleteNamespacedSecret({ name: jobName, namespace: ns }).catch(() => undefined);
    }
  }

  /**
   * Local clusters: build the exact pushed commit from the agent's working copy with the host's Docker,
   * then make the image available to the cluster (registry push, or kind/k3d/minikube image load).
   */
  private async dockerBuild(req: DeployRequest, image: string) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-build-'));
    const tar = path.join(tmp, 'context.tar');
    try {
      const tree = req.contextSubPath ? `${req.commitSha}:${req.contextSubPath.replace(/^\/|\/$/g, '')}` : req.commitSha;
      await run('git', ['-C', req.workspace, 'archive', '--format=tar', '-o', tar, tree]);
      await run('docker', ['build', '-t', image, '-f', req.dockerfile, '-'], { stdinFile: tar, label: 'docker build' });
      switch (config.K8S_IMAGE_LOAD) {
        case 'push':
          await run('docker', ['push', image], { label: 'docker push' });
          break;
        case 'kind':
          await run('kind', ['load', 'docker-image', image, '--name', config.K8S_LOCAL_CLUSTER_NAME], { label: 'kind load' });
          break;
        case 'k3d':
          await run('k3d', ['image', 'import', image, '-c', config.K8S_LOCAL_CLUSTER_NAME], { label: 'k3d image import' });
          break;
        case 'minikube':
          await run('minikube', ['image', 'load', image], { label: 'minikube image load' });
          break;
        case 'none': // Docker Desktop / OrbStack / Rancher Desktop share the Docker image store
          break;
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  private async waitForRollout(namespace: string, name: string, commit: string) {
    const deadline = Date.now() + 6 * 60_000;
    while (Date.now() < deadline) {
      await sleep(4000);
      const d = await this.apps.readNamespacedDeployment({ name, namespace });
      const want = d.spec?.replicas ?? 1;
      const s = d.status;
      if (s && (s.observedGeneration ?? 0) >= (d.metadata?.generation ?? 0) && (s.updatedReplicas ?? 0) >= want && (s.availableReplicas ?? 0) >= want && !s.unavailableReplicas) {
        return;
      }
      // fail fast on obvious pod errors
      const pods = await this.core.listNamespacedPod({ namespace, labelSelector: 'app.kubernetes.io/name=app' });
      for (const p of pods.items) {
        if (p.metadata?.annotations?.['blackbox/commit'] !== commit) continue;
        for (const cs of p.status?.containerStatuses ?? []) {
          const reason = cs.state?.waiting?.reason;
          if (reason && ['CrashLoopBackOff', 'ErrImagePull', 'ImagePullBackOff', 'CreateContainerConfigError'].includes(reason) && (cs.restartCount ?? 0) >= 2) {
            const logs = await this.podLogs(namespace, 'app.kubernetes.io/name=app', 80, true);
            throw new Error(`Pod ${p.metadata?.name} is ${reason}.\n--- logs (tail) ---\n${logs}`);
          }
          if (reason === 'ErrImagePull' || reason === 'ImagePullBackOff') {
            throw new Error(`Pod cannot pull image: ${cs.state?.waiting?.message ?? reason}`);
          }
        }
      }
    }
    const logs = await this.podLogs(namespace, 'app.kubernetes.io/name=app', 80);
    throw new Error(`Rollout did not become ready within 6 minutes (readiness probe failing?).\n--- logs (tail) ---\n${logs}`);
  }

  // ---------------------------------------------------------------- inspect
  async podLogs(namespace: string, labelSelector: string, tailLines = 200, previous = false): Promise<string> {
    const pods = await this.core.listNamespacedPod({ namespace, labelSelector });
    const out: string[] = [];
    for (const p of pods.items.slice(-2)) {
      const name = p.metadata!.name!;
      try {
        const log = await this.core.readNamespacedPodLog({ name, namespace, tailLines, previous });
        out.push(`[${name}]\n${log}`);
      } catch (err) {
        if (previous) {
          const log = await this.core.readNamespacedPodLog({ name, namespace, tailLines }).catch(() => '(no logs)');
          out.push(`[${name}]\n${log}`);
        } else out.push(`[${name}] (logs unavailable: ${(err as Error).message})`);
      }
    }
    return out.join('\n') || '(no pods)';
  }

  async status(namespace: string) {
    const pods = await this.core.listNamespacedPod({ namespace });
    const events = await this.core.listNamespacedEvent({ namespace }).catch(() => ({ items: [] as k8s.CoreV1Event[] }));
    return {
      pods: pods.items.map((p) => ({
        name: p.metadata?.name,
        phase: p.status?.phase,
        ready: p.status?.containerStatuses?.every((c) => c.ready) ?? false,
        restarts: p.status?.containerStatuses?.reduce((n, c) => n + (c.restartCount ?? 0), 0) ?? 0,
        waiting: p.status?.containerStatuses?.map((c) => c.state?.waiting?.reason).filter(Boolean),
      })),
      recentWarnings: events.items
        .filter((e) => e.type === 'Warning')
        .slice(-10)
        .map((e) => `${e.involvedObject?.kind}/${e.involvedObject?.name}: ${e.reason} ${e.message}`),
    };
  }

  async destroy(namespace: string) {
    await this.core.deleteNamespace({ name: namespace }).catch((err) => {
      if (!isNotFound(err)) throw err;
    });
  }

  /** Delete namespaces whose TTL expired. Returns deleted namespace names. */
  async reapExpired(): Promise<string[]> {
    const list = await this.core.listNamespace({ labelSelector: `app.kubernetes.io/managed-by=${MANAGED_BY}` });
    const now = Date.now();
    const deleted: string[] = [];
    for (const ns of list.items) {
      const exp = ns.metadata?.annotations?.['blackbox/expires-at'];
      if (exp && Date.parse(exp) < now && ns.status?.phase !== 'Terminating') {
        await this.destroy(ns.metadata!.name!);
        deleted.push(ns.metadata!.name!);
      }
    }
    return deleted;
  }
}

/** Run a command, keep the tail of its output, and throw with that tail on failure. */
function run(cmd: string, args: string[], opts: { stdinFile?: string; label?: string; timeoutMs?: number } = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.stdinFile ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: { ...process.env, DOCKER_BUILDKIT: '1' } });
    let out = '';
    const keep = (d: Buffer) => {
      out = (out + d.toString()).slice(-12_000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    if (opts.stdinFile) fs.createReadStream(opts.stdinFile).pipe(child.stdin!);
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 30 * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${opts.label ?? cmd} could not start: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${opts.label ?? cmd} failed (exit ${code}).\n--- output (tail) ---\n${out.split('\n').slice(-80).join('\n')}`));
    });
  });
}

let instance: KubernetesEnvironments | undefined;
export function kube(): KubernetesEnvironments {
  if (!config.K8S_ENABLED) throw new Error('Kubernetes environments are disabled (set K8S_ENABLED=true).');
  if (!instance) instance = new KubernetesEnvironments();
  return instance;
}
