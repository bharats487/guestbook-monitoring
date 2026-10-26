# Guestbook Monitoring

Pulumi TypeScript deploys the Guestbook application, Prometheus, Grafana, Redis
metrics exporters, and a blackbox probe to a Kubernetes cluster. The defaults
are intended for Docker Desktop Kubernetes.

## Prerequisites

- Docker Desktop with Kubernetes enabled and a `Ready` node
- Pulumi CLI
- Node.js and npm
- kubectl configured for the target cluster

Confirm the active cluster before deploying:

```powershell
kubectl config current-context
kubectl get nodes
```

For Docker Desktop, the context should be `docker-desktop`.

## Deploy

From this directory in PowerShell:

```powershell
npm install

# Load the local passphrase on this machine, or securely set your own for a new setup.
if (Test-Path .pulumi\passphrase.dpapi) {
    $encrypted = Get-Content .pulumi\passphrase.dpapi | ConvertTo-SecureString
    $env:PULUMI_CONFIG_PASSPHRASE = [System.Net.NetworkCredential]::new('', $encrypted).Password
} else {
    $secure = Read-Host 'Choose a Pulumi stack encryption passphrase' -AsSecureString
    $env:PULUMI_CONFIG_PASSPHRASE = [System.Net.NetworkCredential]::new('', $secure).Password
}

pulumi login --local
pulumi stack init dev
pulumi config set --secret grafanaPassword "Choose-a-strong-password"
npm run build
pulumi up
```

If the `dev` stack already exists, skip `pulumi stack init dev`. Do not run the
`pulumi config set` line again unless intentionally changing the Grafana
password. The DPAPI file is local to this Windows user account and must not be
committed.

Pulumi exports the Guestbook and Grafana URLs, the Grafana username, and the
secret Grafana password. The Grafana username is `admin`; retrieve the password
with:

```powershell
pulumi stack output grafanaPassword --show-secrets
```

Both services are exposed as NodePorts. Docker Desktop's NodePort is not
reachable directly from this Windows host in this setup, so use port-forwarding
in separate PowerShell windows:

```powershell
kubectl port-forward svc/frontend 13081:80
```

```powershell
$grafanaService = kubectl get svc -n monitoring -l app.kubernetes.io/name=grafana -o jsonpath='{.items[0].metadata.name}'
if (-not $grafanaService) { throw "Grafana service was not found." }
kubectl port-forward -n monitoring "svc/$grafanaService" 13000:80
```

Then open the exported URLs:

- Guestbook: `http://localhost:13081`
- Grafana: `http://localhost:13000`

## Monitoring and dashboard

- `redis-leader` and `redis-replica` expose Redis metrics on port `9121`, using
  `redis_exporter`.
- The blackbox exporter probes the Guestbook frontend HTTP endpoint and exposes
  availability and probe latency metrics. The Guestbook image does not provide
  native Prometheus request-count metrics.
- Prometheus also collects Kubernetes pod and container resource metrics.
- Grafana discovers the provisioned Guestbook dashboard automatically.

Check that the deployments are ready:

```powershell
kubectl get pods
kubectl get pods -n monitoring
```

To verify scraping in Prometheus, port-forward the Prometheus service:

```powershell
$services = kubectl get svc -n monitoring -o json | ConvertFrom-Json
$prometheusService = $services.items |
    Where-Object { $_.spec.ports.port -contains 9090 -and $_.spec.clusterIP -ne 'None' } |
    Select-Object -First 1 -ExpandProperty metadata |
    Select-Object -ExpandProperty name
if (-not $prometheusService) { throw "Prometheus service was not found." }
kubectl port-forward -n monitoring "svc/$prometheusService" 9090:9090
```

Then visit `http://localhost:9090/targets` and confirm the frontend probe and
Redis exporter targets are `UP`. Useful PromQL queries include:

```promql
probe_success{job=~".*guestbook-frontend.*"}
probe_duration_seconds{job=~".*guestbook-frontend.*"}
redis_up
rate(redis_commands_processed_total[5m])
container_cpu_usage_seconds_total{namespace="default",pod=~"frontend-.*"}
```

Open Grafana and select the **Guestbook Monitoring** dashboard.

## Clean up

```powershell
pulumi destroy
pulumi stack rm dev
```
