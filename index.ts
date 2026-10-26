import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as fs from "node:fs";
import * as path from "node:path";

const config = new pulumi.Config();
const grafanaAdminPassword = config.requireSecret("grafanaPassword");
const monitoringNamespaceName = "monitoring";

const monitoringNamespace = new k8s.core.v1.Namespace("monitoring", {
    metadata: { name: monitoringNamespaceName },
});

const monitoring = new k8s.helm.v3.Release(
    "monitoring",
    {
        chart: "kube-prometheus-stack",
        version: "69.8.2",
        namespace: monitoringNamespace.metadata.name,
        repositoryOpts: {
            repo: "https://prometheus-community.github.io/helm-charts",
        },
        values: {
            alertmanager: { enabled: false },
            grafana: {
                adminUser: "admin",
                adminPassword: grafanaAdminPassword,
                service: { type: "NodePort", nodePort: 30300 },
                persistence: { enabled: false },
                sidecar: {
                    dashboards: {
                        enabled: true,
                        label: "grafana_dashboard",
                        labelValue: "1",
                        searchNamespace: "ALL",
                    },
                },
            },
            prometheus: {
                prometheusSpec: {
                    probeSelectorNilUsesHelmValues: false,
                    probeSelector: {},
                    probeNamespaceSelector: {},
                    serviceMonitorSelectorNilUsesHelmValues: false,
                    serviceMonitorSelector: {},
                    serviceMonitorNamespaceSelector: {},
                    retention: "24h",
                },
            },
        },
    },
    { dependsOn: monitoringNamespace },
);

const redisLeaderLabels = { app: "redis-leader" };
const redisLeaderDeployment = new k8s.apps.v1.Deployment("redis-leader", {
    spec: {
        selector: { matchLabels: redisLeaderLabels },
        template: {
            metadata: { labels: redisLeaderLabels },
            spec: {
                containers: [
                    {
                        name: "redis-leader",
                        image: "redis:7-alpine",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.67.0",
                        args: ["--redis.addr=redis://localhost:6379"],
                        resources: { requests: { cpu: "25m", memory: "32Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});

new k8s.core.v1.Service("redis-leader", {
    metadata: {
        name: "redis-leader",
        labels: redisLeaderLabels,
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 },
        ],
        selector: redisLeaderDeployment.spec.template.metadata.labels,
    },
});

const redisReplicaLabels = { app: "redis-replica" };
const redisReplicaDeployment = new k8s.apps.v1.Deployment("redis-replica", {
    spec: {
        selector: { matchLabels: redisReplicaLabels },
        template: {
            metadata: { labels: redisReplicaLabels },
            spec: {
                containers: [
                    {
                        name: "replica",
                        image: "pulumi/guestbook-redis-replica",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 6379 }],
                    },
                    {
                        name: "redis-exporter",
                        image: "oliver006/redis_exporter:v1.67.0",
                        args: ["--redis.addr=redis://localhost:6379"],
                        resources: { requests: { cpu: "25m", memory: "32Mi" } },
                        ports: [{ name: "metrics", containerPort: 9121 }],
                    },
                ],
            },
        },
    },
});

new k8s.core.v1.Service("redis-replica", {
    metadata: {
        name: "redis-replica",
        labels: redisReplicaLabels,
    },
    spec: {
        ports: [
            { name: "redis", port: 6379, targetPort: 6379 },
            { name: "metrics", port: 9121, targetPort: 9121 },
        ],
        selector: redisReplicaDeployment.spec.template.metadata.labels,
    },
});

const frontendLabels = { app: "frontend" };
const frontendDeployment = new k8s.apps.v1.Deployment("frontend", {
    spec: {
        selector: { matchLabels: frontendLabels },
        replicas: 3,
        template: {
            metadata: { labels: frontendLabels },
            spec: {
                containers: [
                    {
                        name: "frontend",
                        image: "pulumi/guestbook-php-redis",
                        resources: { requests: { cpu: "100m", memory: "100Mi" } },
                        env: [{ name: "GET_HOSTS_FROM", value: "dns" }],
                        ports: [{ containerPort: 80 }],
                    },
                ],
            },
        },
    },
});

const frontendService = new k8s.core.v1.Service("frontend", {
    metadata: {
        name: "frontend",
        labels: frontendLabels,
    },
    spec: {
        type: "NodePort",
        ports: [{ name: "http", port: 80, targetPort: 80, nodePort: 30081 }],
        selector: frontendDeployment.spec.template.metadata.labels,
    },
});

const redisServiceMonitor = (name: string, labels: Record<string, string>) =>
    new k8s.apiextensions.CustomResource(
        name,
        {
            apiVersion: "monitoring.coreos.com/v1",
            kind: "ServiceMonitor",
            metadata: {
                name,
                namespace: "default",
                labels: { app: name },
            },
            spec: {
                selector: { matchLabels: labels },
                namespaceSelector: { matchNames: ["default"] },
                endpoints: [{ port: "metrics", interval: "30s" }],
            },
        },
        { dependsOn: monitoring },
    );

redisServiceMonitor("redis-leader-monitor", redisLeaderLabels);
redisServiceMonitor("redis-replica-monitor", redisReplicaLabels);

const blackboxConfig = new k8s.core.v1.ConfigMap("blackbox-config", {
    metadata: { name: "blackbox-config", namespace: "default" },
    data: {
        "blackbox.yml": `modules:
  http_2xx:
    prober: http
    timeout: 5s
    http:
      method: GET
      preferred_ip_protocol: ip4
`,
    },
});

const blackboxLabels = { app: "blackbox-exporter" };
const blackboxDeployment = new k8s.apps.v1.Deployment("blackbox-exporter", {
    metadata: { namespace: "default" },
    spec: {
        selector: { matchLabels: blackboxLabels },
        replicas: 1,
        template: {
            metadata: { labels: blackboxLabels },
            spec: {
                containers: [
                    {
                        name: "blackbox-exporter",
                        image: "prom/blackbox-exporter:v0.25.0",
                        args: ["--config.file=/etc/blackbox_exporter/blackbox.yml"],
                        ports: [{ name: "http", containerPort: 9115 }],
                        resources: { requests: { cpu: "25m", memory: "32Mi" } },
                        volumeMounts: [
                            {
                                name: "config",
                                mountPath: "/etc/blackbox_exporter",
                                readOnly: true,
                            },
                        ],
                    },
                ],
                volumes: [
                    {
                        name: "config",
                        configMap: { name: blackboxConfig.metadata.name },
                    },
                ],
            },
        },
    },
});

const blackboxService = new k8s.core.v1.Service("blackbox-exporter", {
    metadata: {
        name: "blackbox-exporter",
        namespace: "default",
        labels: blackboxLabels,
    },
    spec: {
        ports: [{ name: "http", port: 9115, targetPort: 9115 }],
        selector: blackboxDeployment.spec.template.metadata.labels,
    },
});

new k8s.apiextensions.CustomResource(
    "guestbook-frontend-probe",
    {
        apiVersion: "monitoring.coreos.com/v1",
        kind: "Probe",
        metadata: {
            name: "guestbook-frontend",
            namespace: "default",
            labels: { app: "guestbook-frontend" },
        },
        spec: {
            prober: {
                url: pulumi.interpolate`${blackboxService.metadata.name}.default.svc.cluster.local:9115`,
                path: "/probe",
                scheme: "http",
            },
            module: "http_2xx",
            targets: {
                staticConfig: {
                    static: ["http://frontend.default.svc.cluster.local/"],
                },
            },
        },
    },
    { dependsOn: monitoring },
);

const dashboard = JSON.parse(
    fs.readFileSync(path.join(__dirname, "dashboard.json"), "utf8"),
) as Record<string, unknown>;

new k8s.core.v1.ConfigMap(
    "guestbook-dashboard",
    {
        metadata: {
            name: "guestbook-dashboard",
            namespace: monitoringNamespace.metadata.name,
            labels: { grafana_dashboard: "1" },
        },
        data: { "guestbook-dashboard.json": JSON.stringify(dashboard) },
    },
    { dependsOn: monitoring },
);

export const guestbookUrl = "http://localhost:13081";
export const grafanaUrl = "http://localhost:13000";
export const grafanaUsername = "admin";
export const grafanaPassword = grafanaAdminPassword;
