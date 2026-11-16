# Domains and HTTPS

Every app on Opsifier gets an HTTPS address as soon as it is created. This guide covers that default address, your own domains and their certificates, paths, wildcards, and domains that lead to servers outside the panel.

> **Early development.** Opsifier is not ready for production yet. Try it on a server whose data you can afford to lose.

## The address every service gets

A new service is published as `<project>-<service>` under the server's service domain, with HTTPS, sending visitors to port 80 inside its container. The service domain is, by default:

- a name under `sslip.io` built from the server's IP address, which works with no DNS of your own;
- or a free `<id>.opsifier.dev` address, asked for under **Settings, Address**. A person approves each request. The server then gets its own name and one wildcard certificate, so its hostnames are not written one by one to public certificate logs;
- or a domain of your own, under **Settings, General, Service domain**. It needs a wildcard DNS record, such as `*.apps.example.com`, pointing at the server.

## Use your own domain

1. **Point it at the server.** Add a DNS `A` record for the hostname with the server's IP address, which the **Domains** page shows. Ports 80 and 443 must be open.
2. **Add it to the service.** On the service's **Domains** tab, choose **Add domain** and fill in:
   - **Hostname**: the full name, such as `shop.example.com`. A name typed with accents or in another script is turned into the form DNS uses.
   - **Port**, under **Destination inside the service**: the port the app listens on inside its container. **Choose** lists the ports its image declares.
   - **HTTPS**: on, the proxy sends plain HTTP to HTTPS and asks for a certificate.
3. **Wait for the certificate.** The domain answers as soon as it is saved, with no deployment. On the **Domains** page it reads **Waiting for a certificate**, then **Certificate issued** once Let's Encrypt has checked the name over HTTP, which usually takes seconds.

Let's Encrypt writes to the address under **Settings, General, Let's Encrypt** before a certificate expires. The proxy renews certificates by itself.

A service can have several domains. **Make primary** chooses the one **Open this site** opens.

## Route a path

A domain can route a path only, such as `/api`, so that several services of one project share a hostname. Only that path and what is below it reach the service: `/api` never answers for `/apix`, and `/api` and `/api/` mean the same.

- **Remove the path**: the service receives `/users` rather than `/api/users`.
- **Destination path**: added in front of the path the app receives, when it is not `/`.

Two routes that could answer the same request are refused unless they belong to one project. Another project cannot add a longer path under your hostname, nor a wildcard over it.

## Reach a container over HTTPS

When an app only speaks HTTPS inside its container, set the **Protocol** under **Destination inside the service** to **https**. The proxy then checks the container's certificate against the public hostname and the public authorities. Through the API, a domain can also give the name the container's certificate carries and your own authority's certificates, for a self-signed one: `upstreamServerName` and `upstreamCa`. A failed check answers `500`, and the reason is in the proxy's log, under **Settings, General**, menu **Traefik**, **Logs**.

## Wildcard domains

**Wildcard domain**, on the domain's **SSL** tab, makes it answer on every direct subdomain of its hostname as well; the bare hostname needs its own entry. HTTPS on a wildcard needs a certificate resolver that answers Let's Encrypt over DNS, which the default one cannot do. Add one with the proxy's own variables, under **Settings, General**, menu **Traefik**, **Environment**. With Cloudflare, for example:

```text
TRAEFIK_CERTIFICATESRESOLVERS_CLOUDFLARE_ACME_DNSCHALLENGE_PROVIDER=cloudflare
TRAEFIK_CERTIFICATESRESOLVERS_CLOUDFLARE_ACME_EMAIL=you@example.com
TRAEFIK_CERTIFICATESRESOLVERS_CLOUDFLARE_ACME_STORAGE=/var/lib/opsifier/traefik/acme.json
CF_DNS_API_TOKEN=<a token allowed to edit the zone's DNS>
```

Restart the proxy from the same menu, then give the resolver's name, here `cloudflare`, as the domain's **Certificate resolver**, on its **SSL** tab. Each DNS provider has its own variables: see [Traefik's list of providers](https://doc.traefik.io/traefik/https/acme/#providers). Keeping the same storage file as the default resolver lets **Settings, Certificates** list what it holds. Variables that would change how the panel runs the proxy, its providers, entry points and API, are refused.

A wildcard with HTTPS reads **Wildcard HTTPS not verified** until the proxy really holds its certificate.

## Middlewares

A domain's **Middlewares** tab applies Traefik middlewares by name, with an optional `@provider`, such as rate limits or headers defined under **Settings, General**, menu **Traefik**, **Custom configuration**. Names starting with `opsifier-` belong to the panel.

## Redirects, passwords and maintenance

Each service has tabs of its own for what happens in front of it:

- **Redirects**: send one address to another, for example `www.example.com` to `example.com`.
- **Security**: ask for a user name and password before the site opens.
- **Maintenance**: show a maintenance page while you work.

## Domains that lead outside the panel

The **Domains** page lists every hostname the server answers for, with the state of its certificate. Its **Add domain** can also lead to something the panel does not run: choose **Custom** as the destination, and give one or more server addresses, each with a weight to share the traffic. The same HTTPS, path, wildcard and middleware settings apply.

## Certificates

**Settings, Certificates** lists what the proxy holds: each certificate's domain and other names, its resolver, its issuer and the time left. **Remove** makes the proxy forget one and restart; a new one is asked for the next time it is needed.

Certificates from a public authority are written to public Certificate Transparency logs, so a hostname on the server can be found even before anyone links to it.

## Protected servers

Until the server's purpose is production, every site on it asks for the server's password and tells search engines to stay away. The panel's own domains never ask for it, so deployment triggers and Git webhooks keep working. Move the server to production under **Settings, Purpose** when its sites should be public.

## The panel's own address

**Settings, General, Panel domain** gives the panel a domain of its own, which must point at the server. Turn **Serve on IP** off and only its domains answer.
