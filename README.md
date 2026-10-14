# Node.js + Valkey example

A visit counter with sessions, kept in [Valkey](https://valkey.io). Every page view adds to a shared counter, and each browser gets a session (a cookie plus a Valkey hash that expires after 30 minutes without a visit) that counts its own views.

It's a small, dependency-light starting point for any Node.js app that keeps counters, sessions, rate limits or a cache in Valkey on [ComputeSphere](https://computesphere.com).

## Deploy on ComputeSphere

This `computesphere.yaml` creates a web service and a SphereCache (Valkey), and passes the cache's connection string to the app as a secret:

```yaml
version: "2"
project:
  name: valkey-counter
environments:
  - name: production
services:
  - name: cache
    type: valkey
    instance_type: sc-0.1c-256m
  - name: web
    type: web-service
    image: quay.io/computesphere/computesphere-nodejs-valkey-example:1.0.0
    port: 3000
    instance_type: sl-0.25c-512m
    health_check_path: /healthz
    secret_vars:
      REDIS_URL: { fromService: cache, property: uri }
```

## Endpoints

| Path | What it does |
|---|---|
| `GET /` | Counts the visit and shows the total and this browser's count for the session |
| `GET /healthz` | `200 {"ok":true}` once Valkey answers, `503` until then |

## Settings

| Variable | Default | |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | The connection string. A `rediss://` URL connects over TLS. |
| `CA_DIR` | `/etc/computesphere/db` | Over TLS, every `*.crt` file in this directory is trusted to sign the server's certificate. It's read again on each connection attempt, so the app waits (and `/healthz` answers `503`) until the certificate is there. |
| `PORT` | `3000` | The port to listen on. |

## Run it locally

```sh
docker run -d --name valkey -p 6379:6379 valkey/valkey:8-alpine
npm install
npm start
# open http://localhost:3000
```

Or build the image:

```sh
docker build -t valkey-counter .
docker run --rm -p 3000:3000 -e REDIS_URL=redis://host.docker.internal:6379 valkey-counter
```

## How it works

- One client connection, opened at start-up. If it can't connect, the app tries again every 5 seconds, reading the CA directory again each time. Once it has connected, the client reconnects on its own.
- While Valkey is unreachable, requests answer `503` at once instead of waiting.
- A visit runs one `MULTI`: `INCR visits:total`, `HINCRBY session:<id> visits 1`, `EXPIRE session:<id> 1800`.

## License

[MIT](LICENSE)
